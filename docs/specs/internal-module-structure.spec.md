# Internal module structure

- Status: Draft
- Implementation: Architecture rules and canonical JSON `spec`/`policy` leaves
  implemented; RunManager product layers not implemented

## Normative language and versioning

BCP 14 keywords are interpreted per RFC 2119/RFC 8174 only when uppercase.
This unversioned architecture spec follows Accepted ADRs; incompatible
post-implementation product contracts still require a new `vN`.

## Scope

This specification defines the allowed production layers and dependency DAG for
the target `RunManager`.

## Layers

```text
spec      policy      errors
  \          |          /
            domain
               |
            storage     ports
                 \       /
                  lifecycle
                      |
                   manager
                      |
                  composition
```

| Layer         | Responsibility                                              |
| ------------- | ----------------------------------------------------------- |
| `spec`        | immutable public values and bounded JSON contracts          |
| `policy`      | pure retry, limits, and lifecycle policy                    |
| `errors`      | stable typed faults                                         |
| `domain`      | pure aggregate state and prospective transition decisions   |
| `storage`     | type-only transaction, state, event, and eligibility ports  |
| `ports`       | type-only plan, executor, id, clock, and coordination seams |
| `lifecycle`   | sole writable store/domain path; private pipeline seam      |
| `manager`     | public facade, loops, dispatch, recovery, waits, and drain  |
| `composition` | wires injected store/ports to lifecycle and manager         |

## Allowed cross-layer dependencies

- `spec` -> none;
- `policy` -> `spec`;
- `errors` -> `spec`;
- `domain` -> `spec`, `policy`, `errors`;
- `storage` -> `spec`, `errors`, `domain`;
- `ports` -> `spec`, `errors`;
- `lifecycle` -> `spec`, `policy`, `errors`, `domain`, `storage`, `ports`;
- `manager` -> `spec`, `policy`, `errors`, `ports`, `lifecycle`;
- `composition` -> `spec`, `errors`, `storage`, `ports`, `lifecycle`,
  `manager`.

Dependencies within one layer are allowed when acyclic.

`spec`, `errors`, `storage`, and `ports` MUST use type-only imports and exports.
They MUST NOT contain runtime values.

## Pipeline dependency

`canonicalize@3.0.0` is the only installed production external package and may
be imported only by
`src/policy/canonical-json/canonicalize-json.ts`. `node:crypto` may be imported
only by `src/policy/canonical-json/digest-canonical-json.ts`.

`@revisium/revo-pipeline` is the only planned product integration package and
only private `src/lifecycle/pipeline/**` modules may eventually import it. Public
`src/lifecycle/index.ts` and the facade it exports MUST be pipeline-free.
Pipeline-owned types MUST NOT be re-exported or appear in other layer
contracts/declarations. The public plan document exposes only bounded
`JsonValue`; the private lifecycle seam uses the public decoder without casts.

The pipeline dependency is not installed until real lifecycle implementation
requires it.

## Import rules

- Cross-layer imports MUST target the imported layer's explicit `index.ts`
  barrel.
- Manager MUST import lifecycle only through `src/lifecycle/index.ts` and MUST
  use explicit facade contracts rather than `Parameters<>` or `ReturnType<>`
  inference across that boundary.
- A layer leaf MUST NOT import its own barrel.
- Relative ESM imports MUST include the `.js` suffix.
- Barrels MUST use explicit named exports; wildcard exports are forbidden.
- Production leaf files MUST expose one production entity.
- Type-only cycles and runtime cycles are forbidden.
- The package root MAY export only curated composition/public type barrels.
- Tests MAY import production only through the root or curated layer barrels.

## Fail-closed boundaries

Unknown direct children of `src/` MUST fail architecture validation.
Production source MUST NOT import tests, scripts, build output, coverage output,
temporary architecture probes, or repository tooling.

Core MUST reject imports from Prisma, NestJS, GraphQL, MCP, DBOS, queue,
orchestrator, agent-runtime, scripts, and other external packages.

## Positive architecture proof

The architecture harness MUST contain a representative valid graph with all
nine layers. It MUST show:

- type-only store and injected ports;
- plan source returning package-owned document with pipeline `JsonValue`;
- private lifecycle/pipeline as sole pipeline importer and lifecycle as sole
  writable store/domain path;
- pipeline-free public lifecycle index and explicit manager facade contracts;
- manager depending only on its exact allowed layers;
- composition wiring store, lifecycle, and manager;
- root export through curated composition/public types.

## Negative architecture proof

Every enforced rule MUST have an exact-rule negative probe and unit coverage.
At minimum probes MUST reject:

- unknown layers;
- manager -> storage/domain/pipeline;
- manager private-lifecycle imports and `Parameters<>`/`ReturnType<>` boundary
  inference;
- lifecycle public index -> private pipeline seam;
- ports -> pipeline or runtime values;
- composition -> policy/domain/pipeline;
- executor-runtime and scripts imports;
- forbidden and misplaced external imports;
- reverse layer edges;
- runtime values in type-only layers;
- private cross-layer imports;
- missing `.js` suffixes;
- cycles;
- wildcard barrels;
- own-barrel imports;
- production-to-tooling imports;
- tests importing private production leaves.

Temporary on-disk probes MUST always be removed. Oxc MUST execute actual
negative probes with the configured family message for tooling/generated,
Prisma, MCP, orchestrator, agent-runtime, scripts, manager pipeline,
canonicalizer-misplacement, and digest-crypto-misplacement imports.

TypeScript declaration proof MUST compile a valid transitive facade graph and
an intentionally leaking graph, scan declarations reachable from the root
entry, prove the negative marker is detected, and prove the positive graph
contains no pipeline package or marker.
