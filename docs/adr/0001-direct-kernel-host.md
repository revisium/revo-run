# ADR 0001: Direct pipeline-kernel host

## Decision

`revo-run` accepts raw pipeline/profile/input at its manager boundary. It calls
the owning `revo-pipeline` compiler once during admission and hosts the resulting
kernel commands in DBOS. It calls only the owning pipeline state transition for
pipeline control flow and calls only `revo-scripts` for script lifecycle.

## Consequences

- No public lowered execution document, executor map, compiler callback, or consumer
  runner reaches `revo-run`.
- DBOS/PostgreSQL is the sole durable store. There is no Prisma projection,
  package table, scheduler, or recovery database.
- A deterministic operation/attempt identity and private dispatch-intent step
  make script recovery reconcile the same physical attempt after a process crash.
- Script retries are host scheduling only: the immutable prepared binding
  authorizes them, while pipeline routing still receives only the final kernel
  event for that operation.
- Public read models contain normalized observations only; raw pipeline kernel
  values, bindings, handles, paths, and secrets stay private.
- This is a breaking alpha cutover. Old plan/executor APIs are not retained.
- Agent execution is represented only by the private port documented in
  [ADR 0002](0002-private-agent-runtime-port.md) and its production integration
  in [ADR 0003](0003-linux-codex-runtime-and-active-recovery.md). Consumers
  cannot inject a runner or runtime.
- The RN1 package pins the matching revo-agent-runtime, revo-pipeline, and revo-scripts alpha
  artifacts as exact registry dependencies. Local, workspace, Git, URL, and
  tarball references are never package dependencies.

## Rejected alternative

Keeping a second interpreter or lowering layer in `revo-run` would duplicate
pipeline semantics and make recovery route decisions depend on the host. Moving
script lifecycle into the consumer would make durable recovery depend on process
local knowledge. Both violate the ownership boundary.
