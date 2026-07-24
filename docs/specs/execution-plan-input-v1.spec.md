# Execution plan input v1

- Status: Draft
- Implementation: Not implemented

## Normative language and versioning

BCP 14 keywords are interpreted per RFC 2119/RFC 8174 only when uppercase.
`v1` identifies this contract family; incompatible post-Stable changes require a
new `vN`, while this Draft may still change.

## Scope

This specification defines the immutable plan pin persisted by `revo-run`, the
exact plan source injected into `RunManager`, and the package-owned
`RunExecutionPlanDocument` returned through the public port.

The host owns plan authoring, compilation, versioning, persistence, and digest
construction. `revo-run` owns exact lookup and verification during run
lifecycle.

## Requirements

### Persisted pin

Every `Run` MUST persist an immutable plan pin containing:

- `id`;
- `revision`;
- `digest`.

All three values MUST be bounded non-empty strings or a bounded revision value
defined by the final public spec. The full plan MUST NOT be snapshotted in run
storage.

`startRun()` MUST load and verify the exact plan before atomically persisting the
run and pin. Every later operation MUST load the plan automatically from the
persisted pin. A later command MUST NOT supply a replacement plan.

### Exact plan source

The injected `ExecutionPlanSource` MUST expose `loadExact()` by the complete
pin. It MUST return either:

- one immutable package-owned `RunExecutionPlanDocument` whose id, revision,
  and digest exactly match; or
- an explicit stable not-found, unavailable, or mismatch fault.

The manager MUST reject a returned plan when any pin component differs. It MUST
NOT fall back to latest, nearest, compatible, or default revision.

The source MAY cache immutable plans. Cache identity MUST include every pin
component and MUST NOT permit mutable objects or live host services to cross the
port.

### Package-owned plan document

The document MUST contain only JSON-compatible readonly package-owned data
needed to execute and progress a run:

- its exact pin;
- `compiledPipeline` as bounded `JsonValue`;
- immutable node-to-executor bindings;
- bounded retry, timeout, cancellation, and output policies needed by
  `revo-run`;
- stable activation inputs required to derive successor and join activations.

An executor binding MUST carry:

- exact `ExecutorContractPin` with adapter id, contract revision, and contract
  digest;
- bounded immutable JSON configuration;
- exact configuration digest;
- explicit declaration whether repeating after unknown outcome is idempotent.

Missing idempotency declaration means non-idempotent. Resolution MUST use
`resolveExact()` with the complete contract pin and MUST NOT fall back to latest,
default, nearest, or compatible behavior.

The plan MUST NOT contain:

- database clients or repositories;
- executor instances or other live service objects;
- profile, model, prompt, permission, credential, agent, script, or workspace
  services;
- GraphQL, MCP, CLI, NestJS, Prisma, DBOS, queue, or orchestrator types;
- clocks, random generators, callbacks, promises, or mutable collections;
- decoded pipeline values or pipeline-package types.

### Immutability and ownership

The plan source MUST return an immutable snapshot. `revo-run` MUST defensively
copy and bound externally owned scalar, collection, and payload values at its
boundary. Neither the host nor an executor may mutate a plan observed by an
active run.

Plan digest construction is host-owned and opaque to `revo-run`. The package
MUST compare the persisted and loaded digest exactly; it MUST NOT silently
recompute the digest with a package-specific canonicalization.

### Pipeline isolation and decoding

`compiledPipeline` remains `JsonValue` through the public plan source, ports,
manager, composition, and root surface. Only private
`lifecycle/pipeline/**` modules MAY decode it with the future public
`@revisium/revo-pipeline` decoder. The public lifecycle index MUST remain
pipeline-free.

The implementation MUST NOT use a cast to present JSON as a decoded pipeline.
Pipeline-owned types MUST NOT appear in spec, storage, ports, manager,
composition, root exports, or emitted declarations.

Decoder rejection is a stable plan-integrity fault. The manager MUST NOT
dispatch work for a plan whose pipeline JSON has not been decoded and validated.

## Failure behavior

An unavailable exact plan MUST suspend affected progression with a stable
attention/fault state. It MUST NOT mutate the pin, select another plan, or make
new executor dispatches for that run.

A plan mismatch is a data-integrity failure and MUST be recorded durably before
the manager stops progressing the run.

An executor contract or configuration-digest mismatch is also a data-integrity
failure. Recovery MUST retain the persisted exact pin/digest and MUST NOT select
new executor behavior.

## Non-goals

This specification does not define:

- host plan schema or authoring API;
- profile or playbook compilation;
- digest algorithm;
- plan publication or migration;
- pipeline compilation;
- executor implementation discovery outside the injected resolver.

## Required package proof

Before this contract ships, declaration and one-exact-tarball consumer tests
MUST prove:

- `ExecutionPlanSource` returns `RunExecutionPlanDocument`;
- `compiledPipeline` is `JsonValue`;
- declarations reachable through lifecycle facade/manager/composition/root
  contain no pipeline import/type;
- ports/lifecycle facade/manager/composition/root contain no pipeline cast;
- executor resolution requires exact contract pin and configuration digest.
