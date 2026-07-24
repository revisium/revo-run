# @revisium/revo-run

`@revisium/revo-run` is an ESM TypeScript kernel for durable **logical
attempts**. It owns the contract foundation for attempt identity, canonical JSON,
stable SHA-256 digests, and closed external-artifact coordinates.

> Phase 1 is in progress. There is no lifecycle controller, evidence-store
> implementation, execution provider, Agent Runtime integration, Pipeline
> integration, or pipeline-adapter implementation in this release.

## Current public API

```ts
import { canonicalizeJson, digestCanonicalJson } from '@revisium/revo-run';

canonicalizeJson({ b: 1, a: 'value' });
// '{"a":"value","b":1}'

digestCanonicalJson({ a: 1 });
// 'sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862'
```

The functions enforce the durable JSON profile described in
[the JSON envelope specification](./docs/specs/json-envelope-v1.spec.md): no
getters, `toJSON` objects, sparse arrays, cycles, `undefined`, bigint,
functions, symbols, non-finite numbers, or unpaired surrogates. Canonical text
uses RFC 8785 JCS; digests cover its UTF-8 bytes with no trailing newline.

`validateArtifactRefV1()` validates the closed `git-commit`, `github-commit`,
and `revisium-revision` external locator union before any safe-projection digest
or persistence. It has no filesystem, URL parsing, provider, or network effect.

## Boundary

This package will own one logical attempt's durable state and evidence. It does
not own physical provider execution, workflow graph state, retries, scheduling,
or graph-next-node decisions. It has no dependency or import on
`@revisium/revo-pipeline` or `@revisium/revo-agent-runtime`.

The planned Pipeline adapter is a design-only Phase-2 contract and is not a
public export. See [architecture](./docs/architecture.md) and
[specifications](./docs/README.md).

## Development

Requires Node `>=24.11.1 <25` and pnpm `11.13.0`.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

## License

MIT © Revisium
