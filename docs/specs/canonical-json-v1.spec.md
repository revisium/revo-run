# Canonical JSON v1

- Status: Stable
- Version: v1
- Implementation: `@revisium/revo-run/canonical-json`

## Normative language and versioning

BCP 14 keywords are interpreted per RFC 2119/RFC 8174 only when uppercase.
`v1` identifies this Stable contract family. Incompatible semantic changes
require a new `vN`; compatible clarifications remain in `v1` with an explicit
change record.

## Scope

This contract defines the package-owned JSON value type, hostile-input
snapshot, RFC 8785 canonical text, and SHA-256 digest utility used by later
durable contracts. It is a general value utility; its digest is not an
execution-plan pin or an executor-configuration pin.

## Public API

```ts
export type JsonValue =
  boolean | null | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type CanonicalJsonSha256Digest = `sha256:${string}`;

export declare function canonicalizeJson(value: unknown): string;
export declare function digestCanonicalJson(value: unknown): CanonicalJsonSha256Digest;
```

These names are exported only from the semantic
`@revisium/revo-run/canonical-json` subpath. The package root remains
runtime-empty.

## Snapshot profile

Before canonicalization, the implementation MUST copy the complete input
through property descriptors. It MUST NOT invoke getters, setters, or
`toJSON`.

Accepted containers are:

- arrays with the intrinsic array prototype, a standard `length`, no custom
  properties, and one own enumerable data property at every index;
- records whose prototype is either `Object.prototype` or `null`, with only own
  enumerable string-keyed data properties.

The snapshot MUST reject custom prototypes, sparse or extended arrays, symbol
keys, non-enumerable properties, accessors, own `toJSON`, unsupported
primitives, non-finite numbers, and unpaired UTF-16 surrogates in keys or
values. Cycles are rejected. A shared acyclic value MAY appear at multiple
paths and is copied independently at each path.

The completed snapshot MUST be recursively frozen bottom-up before the
canonicalizer is called. Array snapshots MUST use an internal frozen safe
prototype whose only serializer-required method is captured package state.

## Bounds

The snapshot MUST enforce these fixed bounds before calling the RFC 8785
canonicalizer:

- maximum depth: 64 path edges from the root value;
- maximum members: 65,536 total object properties plus array elements;
- maximum canonical UTF-8 size: 1,048,576 bytes, including strings, keys,
  punctuation, and structural bytes.

The exact boundary is accepted; the next unit is rejected.

Invalid values throw `TypeError`. Exceeded bounds throw `RangeError`. Messages
are fixed, bounded, and contain no supplied value.

## Canonical text and digest

`canonicalizeJson` returns RFC 8785 text with no trailing newline.
`digestCanonicalJson` hashes exactly those UTF-8 bytes with SHA-256 and returns
lowercase `sha256:<hex>`.

The runtime dependency `canonicalize@3.0.0` is exact-pinned and may be imported
only by `src/policy/canonical-json/canonicalize-json.ts`. It is Apache-2.0
licensed and has no runtime dependencies. `node:crypto` may be imported only by
the digest leaf. Architecture validation and actual Oxc negative probes enforce
both placements.
Reachable declaration scans MUST prove the semantic subpath does not expose
either runtime dependency, and intentionally leaking fixtures MUST prove both
dependency markers are detected.

## Non-goals

This contract does not ship `ArtifactRef`, `RunOutput`, an execution plan,
pipeline decoding, or manager composition. Artifact references remain deferred
until the current `RunOutput` contract is implemented.
