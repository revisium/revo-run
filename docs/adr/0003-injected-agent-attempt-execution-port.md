# ADR 0003: Injected agent Attempt execution port

## Status

Accepted. Supersedes [ADR 0002](./0002-private-agent-runtime-port.md).

## Decision

`CreateRunManagerOptions.agents` is a required public
`AgentAttemptExecutionPort`. The port is attempt-shaped: it prepares an admitted
agent binding, starts or reconciles one `att_` invocation, obtains its result,
and requests cancellation. It has no discovery, initialization, session, or
shutdown methods.

The application host (currently `revo-core`) owns discovery and the single
process-local `AgentManager`. Before opening Run admission it loads its durable
active-invocation snapshots and calls `AgentManager.initialize(...)`; runtime
initialization identity-checks and reaps recorded processes. The host is
responsible for the active-state sink and for retaining enough durable snapshot
state to make restart reconciliation fail closed.

`createAgentAttemptExecutionAdapter` is an optional public convenience helper.
It adapts only `AgentManager.getAgent`, `start`, `getResult`, and `cancel` plus
host workspace and credential resolvers. The helper does not discover, create,
initialize, or shut down the manager. Its own `shutdown()` closes adapter
admission, drains pending starts, and disposes credential leases.

At shutdown the host first closes admission and shuts down the shared
`AgentManager`, allowing provider processes and active-state removals to settle
while their credential leases still exist. It then stops the Run manager/DBOS
and finally shuts down the adapter to release remaining leases. `revo-run` owns
DBOS lifecycle and pipeline Attempt calls, not the shared runtime lifecycle.

The injected port is not a consumer-provided runner map. It is one host service
with a closed Attempt contract; pipeline routing remains in
`@revisium/revo-pipeline`. The historically banned run-executor symbol is not
introduced.

## Consequences

- A host may colocate Run and agent execution today without transferring
  `AgentManager` ownership to `revo-run`.
- A future separated runner can implement the same Attempt port across a
  transport without changing pipeline semantics or exposing provider handles.
- Active-process snapshot persistence and restart reaping are host obligations.
  The former `revo-run` DBOS active-invocation registry is no longer part of the
  integration.
- Tests inject an explicit port; an unavailable internal test port may be used
  only where a pipeline cannot execute an agent Attempt.
