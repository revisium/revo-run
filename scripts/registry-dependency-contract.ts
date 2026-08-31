import assert from 'node:assert/strict';

import { parseDocument } from 'yaml';

type JsonRecord = Record<string, unknown>;

type RegistryDependencyContract = {
  manifest: unknown;
  lockfile: unknown;
  workspace: unknown;
};

type RegistryDependencyFiles = {
  manifestSource: string;
  lockfileSource: string;
  workspaceSource: string;
};

export const registryRuntimeDependencies = Object.freeze({
  '@revisium/revo-agent-runtime': Object.freeze({
    integrity:
      'sha512-UeL2eP+fmCf6zpnkwYWE7z7XX1UMIihtvIAQOup7sAME9Bi0cqQbzGCv/q1PL/FKkEK23f8RooRpPxkKiK6vPg==',
    snapshotDependencies: Object.freeze({
      ajv: '8.20.0',
      canonicalize: '3.0.0',
      zod: '4.4.3',
    }),
    version: '0.1.0-alpha.0',
  }),
  '@revisium/revo-pipeline': Object.freeze({
    integrity:
      'sha512-r+lBnr/SD5Q6SfbKtkjf0uuPZfK4noGUuzoGu+50KRbeFPtdFFXBoZMX1+8L1OG5nORi1auK+p4dZ4hZZmjGLg==',
    snapshotDependencies: Object.freeze({ canonicalize: '4.0.0', typebox: '1.3.10' }),
    version: '0.2.0-alpha.3',
  }),
  '@revisium/revo-scripts': Object.freeze({
    integrity:
      'sha512-HFLiJaVUr+ffSkfJXQmo8jXkpOC6A3++j5MXG7YCDtTxc/j0aZieWTKIzL5AVscyRix2D1+mj9g00LenIWxE+Q==',
    snapshotDependencies: Object.freeze({
      '@standard-schema/spec': '1.1.0',
      ajv: '8.20.0',
      canonicalize: '3.0.0',
      zod: '4.4.3',
    }),
    version: '0.1.0-alpha.1',
  }),
});

const expectedWorkspaceKeys = ['allowBuilds', 'minimumReleaseAgeExclude', 'packages'];
const forbiddenReference =
  /^(?:file:|link:|workspace:|portal:|patch:|git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|https?:|(?:\.{1,2}\/|\/)|.*\.(?:tgz|tar|tar\.gz))$/iu;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown, label: string): JsonRecord => {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be a mapping.`);
  }
  return value;
};

const parseYamlMapping = (source: string, label: string): JsonRecord => {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new TypeError(`${label} must be valid YAML without duplicate keys.`);
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  return requireRecord(value, label);
};

const assertNoForbiddenReferences = (value: unknown, label: string): void => {
  if (typeof value === 'string') {
    assert.doesNotMatch(value, forbiddenReference, `${label} contains a non-registry reference.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenReferences(entry, `${label}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoForbiddenReferences(key, `${label} key`);
      assertNoForbiddenReferences(entry, `${label}.${key}`);
    }
  }
};

const dependencyKey = (packageName: string, version: string): string => `${packageName}@${version}`;

export const assertRegistryDependencyContract = ({
  manifest,
  lockfile,
  workspace,
}: RegistryDependencyContract): void => {
  const packageJson = requireRecord(manifest, 'package.json');
  const dependencies = requireRecord(packageJson['dependencies'], 'package.json dependencies');
  assert.equal(packageJson['overrides'], undefined, 'package.json overrides are not allowed.');
  assert.equal(packageJson['pnpm'], undefined, 'package.json pnpm overrides are not allowed.');
  assert.equal(packageJson['resolutions'], undefined, 'package.json resolutions are not allowed.');

  const lock = requireRecord(lockfile, 'pnpm-lock.yaml');
  assert.deepEqual(
    Object.keys(lock).sort(),
    ['importers', 'lockfileVersion', 'packages', 'settings', 'snapshots'],
    'pnpm-lock.yaml contains an unsupported top-level resolver surface.',
  );
  const importers = requireRecord(lock['importers'], 'pnpm-lock.yaml importers');
  assert.deepEqual(
    Object.keys(importers),
    ['.'],
    'pnpm-lock.yaml must have only the root importer.',
  );
  const rootImporter = requireRecord(importers['.'], 'pnpm-lock.yaml root importer');
  const importerDependencies = requireRecord(
    rootImporter['dependencies'],
    'pnpm-lock.yaml root dependencies',
  );
  const packages = requireRecord(lock['packages'], 'pnpm-lock.yaml packages');
  const snapshots = requireRecord(lock['snapshots'], 'pnpm-lock.yaml snapshots');

  for (const [packageName, expected] of Object.entries(registryRuntimeDependencies)) {
    assert.equal(
      dependencies[packageName],
      expected.version,
      `${packageName} must be an exact manifest dependency.`,
    );
    const importer = requireRecord(
      importerDependencies[packageName],
      `${packageName} lockfile importer`,
    );
    assert.deepEqual(
      importer,
      { specifier: expected.version, version: expected.version },
      `${packageName} lockfile importer must resolve the exact registry version.`,
    );

    const key = dependencyKey(packageName, expected.version);
    assert.deepEqual(
      Object.keys(packages).filter((candidate) => candidate.startsWith(`${packageName}@`)),
      [key],
      `${packageName} must have exactly one package resolution.`,
    );
    const packageRecord = requireRecord(packages[key], `${packageName} package resolution`);
    assert.deepEqual(
      packageRecord['resolution'],
      { integrity: expected.integrity },
      `${packageName} must use the expected npm integrity without a local or tarball resolution.`,
    );

    assert.deepEqual(
      Object.keys(snapshots).filter((candidate) => candidate.startsWith(`${packageName}@`)),
      [key],
      `${packageName} must have exactly one registry snapshot.`,
    );
    const snapshot = requireRecord(snapshots[key], `${packageName} package snapshot`);
    assert.deepEqual(
      snapshot,
      { dependencies: expected.snapshotDependencies },
      `${packageName} snapshot must match the published dependency graph.`,
    );
  }

  const workspaceConfig = requireRecord(workspace, 'pnpm-workspace.yaml');
  assert.deepEqual(
    Object.keys(workspaceConfig).sort(),
    expectedWorkspaceKeys,
    'pnpm-workspace.yaml contains an unsupported resolver surface.',
  );
  assert.deepEqual(
    workspaceConfig['minimumReleaseAgeExclude'],
    Object.entries(registryRuntimeDependencies).map(
      ([packageName, expected]) => `${packageName}@${expected.version}`,
    ),
    'minimumReleaseAgeExclude must contain only approved exact registry versions.',
  );

  assertNoForbiddenReferences(lock, 'pnpm-lock.yaml');
  assertNoForbiddenReferences(workspaceConfig, 'pnpm-workspace.yaml');
};

export const assertRegistryDependencyFiles = ({
  manifestSource,
  lockfileSource,
  workspaceSource,
}: RegistryDependencyFiles): void => {
  const manifest: unknown = JSON.parse(manifestSource);
  assertRegistryDependencyContract({
    manifest,
    lockfile: parseYamlMapping(lockfileSource, 'pnpm-lock.yaml'),
    workspace: parseYamlMapping(workspaceSource, 'pnpm-workspace.yaml'),
  });
};
