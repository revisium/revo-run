# Internal Module Structure

- Status: Draft architecture contract
- Enforcement: active in repository tooling
- Runtime implementation: none

## Target layers

```text
src/
├── index.ts
├── spec/
├── policy/
├── errors/
├── domain/
├── storage/
└── lifecycle/
```

| Layer       | Syntax/role                        | Allowed dependencies                       |
| ----------- | ---------------------------------- | ------------------------------------------ |
| `spec`      | type-only portable contracts       | same layer                                 |
| `policy`    | immutable/pure policy              | `spec`                                     |
| `errors`    | type-only fault/conflict contracts | `spec`                                     |
| `domain`    | pure state/transition behavior     | `spec`, `policy`, `errors`                 |
| `storage`   | type-only command/query ports      | `spec`, `errors`, `domain`                 |
| `lifecycle` | package use cases                  | all earlier layers, public `revo-pipeline` |

Lifecycle alone coordinates the pipeline seam. Domain first validates expected
state/fence/gate revision and computes a package-owned prospective state/output
change without commit. Lifecycle combines authoritative sibling state with that
prospective outcome/answer into `PipelineFacts`, invokes the public decision
API, and maps `PipelineDecision` to package-owned successor/join/wait intents.
Domain validates the combined intent/invariants, then storage CASes expected
Run/node/Attempt revisions and atomically commits the prospective state,
outputs, events, and activations. Pipeline types do not leak into spec or domain.

## Structural rules

- Only the six listed `src/*` layers exist; unknown layers fail closed.
- Every relative module specifier ends in `.js`.
- Every cross-layer import targets that layer's explicit `index.ts` barrel.
- A leaf never imports its own layer barrel.
- Barrels use explicit named exports; no `export *`.
- Production leaves export exactly one entity.
- `spec`, `errors`, and `storage` contain only type imports, interfaces, type
  aliases, and type exports.
- Type-only cycles are forbidden.
- Production never imports tests, repository scripts, build/coverage output, or
  architecture probes.
- Tests import production only through `src/index.ts` or a curated layer
  `index.ts`; private source leaves remain private. Tests may still import
  Vitest, Node, and owned repository tooling for structural tests.
- The only permitted external production import is
  `@revisium/revo-pipeline`, and only from `lifecycle`.
- MCP and orchestrator package imports have explicit forbidden diagnostics;
  every other external package fails closed.
- Root exports are curated explicitly; directory presence never creates API.

## Enforcement proof

`scripts/architecture/validate-module-structure.ts` parses TypeScript and
enforces each rule, including type-only edges. `scripts/verify-architecture.ts`:

1. validates the real source and test graph;
2. validates a representative synthetic target graph containing every layer;
3. runs Oxc cycle/restricted-import checks and a negative Oxc configuration probe;
4. proves every rule with an exact negative probe;
5. proves forbidden external, host-package, repository-target, unknown-layer,
   and private-test imports fail with their exact rule ids;
6. removes its temporary probe directory and asserts no probe remains.

The synthetic graph is required while the shipped API and implementation are
empty. Architecture rules cannot be weakened merely because no current file
violates them.
