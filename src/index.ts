import { createHash } from 'node:crypto';

import canonicalize from 'canonicalize';

/** A JSON value accepted by the durable contract profile. */
export type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ContractErrorV1 = {
  readonly schemaVersion: 'revo-run/contract-error/v1';
  readonly code: 'revo.run.contract_invalid';
  readonly path: string;
  readonly rule: string;
  readonly message: string;
  readonly retryable: false;
};

export type ExternalLocatorV1 =
  | { readonly kind: 'git-commit'; readonly repositoryId: string; readonly commit: string }
  | { readonly kind: 'github-commit'; readonly repositoryId: string; readonly commit: string }
  | { readonly kind: 'revisium-revision'; readonly projectId: string; readonly revisionId: string };

export type ArtifactRefV1 = {
  readonly schemaVersion: 'revo-run/artifact-ref/v1';
  readonly mode: 'inline' | 'content-addressed' | 'external';
  readonly mediaType: string;
  readonly contentDigest: string | null;
  readonly bytes: number | null;
  readonly inline: JsonValue | null;
  readonly locator: ExternalLocatorV1 | null;
  readonly immutableRevision: string | null;
  readonly retentionClass: 'ephemeral' | 'run' | 'retained';
};

export type ArtifactValidationResultV1 =
  | { readonly ok: true; readonly value: ArtifactRefV1 }
  | { readonly ok: false; readonly error: ContractErrorV1 };

const hasUnpairedSurrogate = (value: string): boolean => {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
};

const isArrayIndex = (key: string): boolean => {
  if (key.length === 0) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && String(index) === key && index >= 0 && index < 2 ** 32 - 1;
};

const canonicalArrayPrototype: object = {};
Object.setPrototypeOf(canonicalArrayPrototype, null);
Object.defineProperty(canonicalArrayPrototype, 'map', {
  configurable: false,
  enumerable: false,
  value: Array.prototype.map,
  writable: false,
});

const copyArray = (value: unknown[], ancestors: WeakSet<object>): readonly JsonValue[] => {
  const copy: JsonValue[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (key !== 'length' && !isArrayIndex(key))) {
      throw new TypeError('JCS arrays must not have custom properties.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (key !== 'length' && (!descriptor || !('value' in descriptor))) {
      throw new TypeError('JCS arrays must not use getters or setters.');
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError('JCS arrays must not be sparse.');
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError('JCS arrays must not use getters or setters.');
    }
    Object.defineProperty(copy, String(index), {
      configurable: true,
      enumerable: true,
      value: copyCanonicalValue(descriptor.value, ancestors),
      writable: true,
    });
  }
  Object.setPrototypeOf(copy, canonicalArrayPrototype);
  return copy;
};

const copyObject = (
  value: object,
  ancestors: WeakSet<object>,
): { readonly [key: string]: JsonValue } => {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('JCS values must use plain objects.');
  }
  const copy: { [key: string]: JsonValue } = {};
  Object.setPrototypeOf(copy, null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError('JCS objects must not use symbol keys.');
    if (key === 'toJSON') throw new TypeError('JCS objects must not define toJSON.');
    if (hasUnpairedSurrogate(key))
      throw new TypeError('JCS object keys must not contain unpaired surrogates.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError('JCS objects must not use getters or setters.');
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: copyCanonicalValue(descriptor.value, ancestors),
      writable: true,
    });
  }
  return copy;
};

function copyCanonicalValue(value: unknown, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS values must contain finite numbers.');
    return value;
  }
  if (typeof value === 'string') {
    if (hasUnpairedSurrogate(value))
      throw new TypeError('JCS strings must not contain unpaired surrogates.');
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('JCS values must contain only JSON primitives, arrays, and plain objects.');
  }
  if (ancestors.has(value)) throw new TypeError('JCS values must not contain cycles.');

  ancestors.add(value);
  try {
    return Array.isArray(value) ? copyArray(value, ancestors) : copyObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

/** Returns RFC 8785 JCS text after enforcing the revo-run durable-value profile. */
export const canonicalizeJson = (value: unknown): string => {
  const snapshot = copyCanonicalValue(value, new WeakSet<object>());
  const result = canonicalize(snapshot);
  if (result === undefined) throw new TypeError('JCS canonicalization did not produce JSON text.');
  return result;
};

/** Returns a lowercase SHA-256 digest over the canonical UTF-8 JSON bytes. */
export const digestCanonicalJson = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex')}`;

const contractError = (path: string, rule: string): ContractErrorV1 => ({
  code: 'revo.run.contract_invalid',
  message: 'Artifact reference does not satisfy the durable contract.',
  path,
  retryable: false,
  rule,
  schemaVersion: 'revo-run/contract-error/v1',
});

const artifactError = (path: string, rule: string): ArtifactValidationResultV1 => ({
  error: contractError(path, rule),
  ok: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const forbiddenCoordinate = (value: string): boolean =>
  /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[/\\@]/.test(value) || /%2f/i.test(value);

const isOpaqueId = (value: unknown): value is string =>
  typeof value === 'string' &&
  !forbiddenCoordinate(value) &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const isCommit = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

const expectedRevision = (locator: ExternalLocatorV1): string => {
  switch (locator.kind) {
    case 'git-commit':
      return `git:${locator.commit}`;
    case 'github-commit':
      return `github:${locator.repositoryId}@${locator.commit}`;
    case 'revisium-revision':
      return `revisium:${locator.projectId}@${locator.revisionId}`;
  }
  throw new Error('Unsupported external locator kind.');
};

const allowedLocatorKeys = (kind: string): readonly string[] | undefined => {
  switch (kind) {
    case 'git-commit':
    case 'github-commit':
      return ['kind', 'repositoryId', 'commit'];
    case 'revisium-revision':
      return ['kind', 'projectId', 'revisionId'];
    default:
      return undefined;
  }
};

const validateLocator = (value: unknown): ExternalLocatorV1 | ContractErrorV1 => {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return contractError('/locator/kind', 'locator_kind_invalid');
  }

  const allowedKeys = allowedLocatorKeys(value.kind);
  if (!allowedKeys) return contractError('/locator/kind', 'locator_kind_invalid');
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return contractError(`/locator/${key}`, 'unknown_field');
  }

  if (value.kind === 'revisium-revision') {
    const projectId = value.projectId;
    if (typeof projectId === 'string' && forbiddenCoordinate(projectId)) {
      return contractError('/locator/projectId', 'locator_forbidden_coordinate');
    }
    if (!isOpaqueId(projectId))
      return contractError('/locator/projectId', 'locator_identifier_invalid');
    const revisionId = value.revisionId;
    if (typeof revisionId === 'string' && forbiddenCoordinate(revisionId)) {
      return contractError('/locator/revisionId', 'locator_forbidden_coordinate');
    }
    if (!isOpaqueId(revisionId)) {
      return contractError('/locator/revisionId', 'locator_identifier_invalid');
    }
    return { kind: 'revisium-revision', projectId, revisionId };
  }

  const repositoryId = value.repositoryId;
  if (typeof repositoryId === 'string' && forbiddenCoordinate(repositoryId)) {
    return contractError('/locator/repositoryId', 'locator_forbidden_coordinate');
  }
  if (!isOpaqueId(repositoryId)) {
    return contractError('/locator/repositoryId', 'locator_identifier_invalid');
  }
  const commit = value.commit;
  if (!isCommit(commit)) return contractError('/locator/commit', 'locator_commit_invalid');
  return value.kind === 'git-commit'
    ? { kind: 'git-commit', repositoryId, commit }
    : { kind: 'github-commit', repositoryId, commit };
};

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);

const isMediaType = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 3 &&
  value.length <= 127 &&
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);

/** Validates the closed external-artifact coordinates before digest or persistence. */
export const validateArtifactRefV1 = (value: unknown): ArtifactValidationResultV1 => {
  if (!isRecord(value)) return artifactError('', 'artifact_invalid');
  const rootFields = new Set([
    'schemaVersion',
    'mode',
    'mediaType',
    'contentDigest',
    'bytes',
    'inline',
    'locator',
    'immutableRevision',
    'retentionClass',
  ]);
  for (const key of Object.keys(value)) {
    if (!rootFields.has(key)) return artifactError(`/${key}`, 'unknown_field');
  }
  if (value.schemaVersion !== 'revo-run/artifact-ref/v1') {
    return artifactError('/schemaVersion', 'schema_version_invalid');
  }
  if (!isMediaType(value.mediaType)) return artifactError('/mediaType', 'media_type_invalid');
  if (value.contentDigest !== null && !isSha256(value.contentDigest)) {
    return artifactError('/contentDigest', 'sha256_invalid');
  }
  if (value.bytes !== null && !isSafeInt(value.bytes))
    return artifactError('/bytes', 'safe_int_invalid');
  if (
    value.retentionClass !== 'ephemeral' &&
    value.retentionClass !== 'run' &&
    value.retentionClass !== 'retained'
  ) {
    return artifactError('/retentionClass', 'retention_class_invalid');
  }
  const mode = value.mode;
  if (mode !== 'inline' && mode !== 'content-addressed' && mode !== 'external') {
    return artifactError('/mode', 'artifact_mode_invariant');
  }
  let inline: JsonValue | null;
  try {
    inline = value.inline === null ? null : copyCanonicalValue(value.inline, new WeakSet<object>());
  } catch {
    return artifactError('/inline', 'json_value_invalid');
  }

  if (mode === 'inline') {
    if (value.locator !== null) return artifactError('/locator', 'artifact_mode_invariant');
    if (value.immutableRevision !== null)
      return artifactError('/immutableRevision', 'artifact_mode_invariant');
    if (inline === null || value.bytes === null || value.contentDigest === null) {
      return artifactError('/inline', 'artifact_mode_invariant');
    }
    const canonicalBytes = Buffer.byteLength(canonicalizeJson(inline), 'utf8');
    if (canonicalBytes > 65_536) return artifactError('/inline', 'inline_bytes_exceeded');
    if (value.bytes !== canonicalBytes) return artifactError('/bytes', 'artifact_mode_invariant');
    if (value.contentDigest !== digestCanonicalJson(inline)) {
      return artifactError('/contentDigest', 'artifact_mode_invariant');
    }
    return {
      ok: true,
      value: {
        bytes: value.bytes,
        contentDigest: value.contentDigest,
        immutableRevision: null,
        inline,
        locator: null,
        mediaType: value.mediaType,
        mode,
        retentionClass: value.retentionClass,
        schemaVersion: value.schemaVersion,
      },
    };
  }
  if (mode === 'content-addressed') {
    if (inline !== null) return artifactError('/inline', 'artifact_mode_invariant');
    if (value.locator !== null) return artifactError('/locator', 'artifact_mode_invariant');
    if (value.immutableRevision !== null) {
      return artifactError('/immutableRevision', 'artifact_mode_invariant');
    }
    if (value.bytes === null || value.contentDigest === null) {
      return artifactError('/contentDigest', 'artifact_mode_invariant');
    }
    return {
      ok: true,
      value: {
        bytes: value.bytes,
        contentDigest: value.contentDigest,
        immutableRevision: null,
        inline: null,
        locator: null,
        mediaType: value.mediaType,
        mode,
        retentionClass: value.retentionClass,
        schemaVersion: value.schemaVersion,
      },
    };
  }
  if (value.locator === null || value.locator === undefined) {
    return artifactError('/locator', 'external_locator_required');
  }
  if (value.immutableRevision === null || value.immutableRevision === undefined) {
    return artifactError('/immutableRevision', 'external_locator_required');
  }
  if (!isSafeInt(value.bytes)) return artifactError('/bytes', 'external_locator_required');
  if (inline !== null) return artifactError('/inline', 'artifact_mode_invariant');

  const locator = validateLocator(value.locator);
  if ('schemaVersion' in locator) return { error: locator, ok: false };
  if (value.immutableRevision !== expectedRevision(locator)) {
    return artifactError('/immutableRevision', 'locator_revision_mismatch');
  }
  return {
    ok: true,
    value: {
      bytes: value.bytes,
      contentDigest: value.contentDigest,
      immutableRevision: value.immutableRevision,
      inline: null,
      locator,
      mediaType: value.mediaType,
      mode,
      retentionClass: value.retentionClass,
      schemaVersion: value.schemaVersion,
    },
  };
};
