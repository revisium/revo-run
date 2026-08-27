# RN1 architecture

`revo-run` is a durable host, not a second pipeline engine.

```text
revo-core
  -> revo-run manager: raw pipeline, profile, input, host resolvers
       -> revo-pipeline: compile, initial state, commands, transitions
       -> revo-scripts: binding preparation, one physical script attempt
       -> DBOS/PostgreSQL: admission snapshot, operation history, events
```

The consumer supplies only the raw `PipelineSourcePackage`, `RunProfile`, JSON
input, and host resolvers. `createRun()` compiles once, prepares script bindings,
and starts a DBOS root workflow. The admitted snapshot is immutable; recovery
does not recompile or reselect profile values.

## Durable operation boundary

For each kernel command that requires host work, the root records a deterministic
operation ID and starts a child workflow. The child owns one operation outbox
record and derives one script attempt ID. The root owns the public event stream,
receipt deduplication, and calls `advancePipeline`; it never selects a route or
settles source-language control flow itself.

`ScriptDispatchIntentV1` is a private DBOS step. It stores the operation child
workflow's recovery-attempt baseline before provider work. Inside the following
unfinished provider step, the child reads its live DBOS recovery count:

- equal to the baseline: execute the script attempt;
- greater than the baseline: reconcile the same attempt identity;
- proven `notFound`: record one fresh dispatch intent, then execute that same
  identity once under its fresh baseline;
- unknown or uncertain: relay `recovery_required`, without a kernel event;
- missing, invalid, or decreasing count: fail closed.

This avoids using a second database or a public recovery API. The readiness fence
is checked before every execute or reconciliation call, so DBOS launch/recovery
cannot reach a host adapter before manager composition is ready.

Script retry is intentionally narrow. A new attempt is scheduled only for a
terminal `failed` or `timedOut` result when the admitted script binding says
`transient`, the failure is `retryable`, an ordinal remains, and idempotency is
not `not-retryable`. It keeps the operation/execution identity, creates a new
attempt identity, and uses a durable DBOS sleep for the admitted backoff. An
uncertain outcome never creates a retry.

## Public boundary

Only `@revisium/revo-run` root exports are supported. It exposes the manager,
closed public schemas, public run values, raw pipeline/profile types, and host
resolver types. It does not export a lowered plan, pipeline kernel, admitted
snapshot, DBOS record, prepared binding, or a deep import surface.

Agent-bearing public admission remains fail-closed with `agent_runtime_unavailable`
until the separate agent adapter is approved. Repository-only fixtures exercise
the private port's pinned result validation and same-identity cancel/lookup path;
they are not a production adapter or consumer option.

## Release fence

RN1 pins the compatible PL1 and SC1 alphas as exact registry dependencies.
`verify-package` refuses to compensate by linking undeclared runtime
dependencies, and no local, workspace, Git, URL, or tarball dependency is an
acceptable substitute.

## Evidence map

The host does not reimplement the source language. These representative runs
prove that each command family reaches the pipeline kernel and returns its
event to the one serialized root lane:

| Source semantics                                     | RN1 evidence                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `script`                                             | `raw-kernel-run.test.ts` and `rn1-script-recovery.test.ts`                                          |
| `agent` single                                       | private known-v1 fixture in `rn1-private-agent-port.test.ts`                                        |
| `consensus` / three agent participants               | same private fixture; public admission remains fail-closed                                          |
| `choice`, `call`, `parallel`, `repeat`, `map`, `end` | `rn1-control-flow-conformance.test.ts`                                                              |
| duration and signal `wait`                           | `rn1-control-flow-conformance.test.ts`, `raw-kernel-run.test.ts`, and fresh-process signal recovery |
| `humanGate` answer, deadline, cancellation           | `raw-kernel-run.test.ts`                                                                            |

The crash matrix is intentionally split by durable boundary rather than by an
in-process mock. D1 is admission's no-commit/no-call proof. D2–D5 and D8 use
fresh DBOS processes in `rn1-script-dispatch-recovery-process.test.ts`; D6 uses
the signal child recovery process plus fresh duration, gate, and parallel child
processes; D7 and D9 use the same-identity recovery and late sealed-terminal
cases in `rn1-script-recovery.test.ts`.

| Row | Durable proof                                                                            |
| --- | ---------------------------------------------------------------------------------------- |
| D1  | rejected raw admission leaves no DBOS workflow or resolver call                          |
| D2  | crash before dispatch intent rebuilds the intent and re-arbitrates the same identity     |
| D3  | SIGKILL after acceptance/claim reconciles the existing identity; no second execute       |
| D4  | sealed terminal pair survives child crash and is published exactly once                  |
| D5  | a stored transition resumes only its next outbox                                         |
| D6  | signal, duration, gate, and parallel identities survive a fresh process                  |
| D7  | unresolved/unknown reconciliation is public `recovery_required`, never a guessed outcome |
| D8  | committed live relay drains once after child death without handler re-entry              |
| D9  | a late matching sealed terminal atomically clears recovery and advances once             |

`verify-package` scans packed JavaScript and declarations for test hooks/markers,
checks exact registry pins, and validates the root surface in an isolated packed
consumer.
