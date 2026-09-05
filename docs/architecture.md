# RN1 architecture

`revo-run` is a durable host, not a second pipeline engine.

```text
revo-core
  -> agent runtime host: discovery, AgentManager initialization and shutdown,
                         active-state durability and restart reaping
  -> revo-run manager: raw pipeline, profile, input, host resolvers,
                       required AgentAttemptExecutionPort
       -> revo-pipeline: compile, initial state, commands, transitions
       -> revo-scripts: binding preparation, one physical script attempt
       -> injected agent port: one pipeline agent Attempt
       -> DBOS/PostgreSQL: admission snapshot, operation history, events
```

The host supplies the raw `PipelineSourcePackage`, `RunProfile`, JSON input,
host resolvers, and one required `AgentAttemptExecutionPort`. `createRun()`
compiles once, prepares script and agent bindings through those injected
boundaries, and starts a DBOS root workflow. The admitted
snapshot is immutable; recovery does not recompile or reselect profile values.

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
closed public schemas, public run values, raw pipeline/profile types, host
resolver types, the `AgentAttemptExecutionPort`, and the optional
`createAgentAttemptExecutionAdapter` helper. It does not export a lowered plan,
pipeline kernel, admitted snapshot, DBOS record, prepared binding, runner map,
the historically banned run-executor symbol, or a deep import surface.

The application host discovers definitions, constructs the process-local
`AgentManager`, supplies its durable active-state sink, and initializes it with
active snapshots before opening Run admission. Runtime initialization owns
identity checking and reaping. The optional adapter pins the selected definition
and digest in the admitted snapshot. Configuration selections are copied into
the prepared binding and validated again by the runtime's fresh invocation
session. Logical workspace references and credential aliases remain durable;
acquired paths, secrets, and runtime handles remain process-local. Unsupported
or unavailable definitions fail before workspace acquisition, script
preparation, process launch, or DBOS admission.

Only a minimal prepared binding and sanitized terminal carrier enter durable
history. Raw environment, metadata, launch evidence, files, output paths, and
process handles remain process-local. A shared recursive sanitizer rejects
secret-shaped and normalized acronym credential keys and captured secret values.
Its lexical token scanner rejects atom-started POSIX absolutes including root and
punctuation-leading segments, drive absolutes, backslash UNC/device paths, and
file URI tokens anywhere in success or failure text. A non-file URL exemption
requires full RFC3986 consumption to end, whitespace, control, or a
deterministically selected rightmost full-valid external wrapper closer.
Unknown or out-of-grammar input invalidates the whole candidate and exposes its
first slash. Wrapper characters that are RFC data remain data unless selected
as the maximal valid envelope boundary. RFC URL and maximal-valid wrapper
recognition uses one forward O(n) parse with bounded state; closer count does not
multiply parsing work.

Active-invocation snapshot durability is a host obligation, outside
`revo-run`. The host initializes its manager from those snapshots so the runtime
can identity-check and reap recorded detached process groups before Run admission
opens. The old internal DBOS active-invocation registry is no longer used.
Durable Run recovery observes an unknown Attempt result as
`recovery_required` and never launches a replacement process.

Graceful application stop closes admission, shuts down the shared manager while
credentials and the host active-state sink remain available, stops the Run
manager/DBOS, and then shuts down the adapter to dispose remaining credential
leases. The Run manager itself owns only public-call draining and DBOS lifecycle.

## Release fence

RN1 pins the compatible AG1, PL1, and SC1 alphas as exact registry dependencies.
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
| `agent` single                                       | Injected Attempt-port and generic-runtime adapter conformance; DBOS unknown-result recovery         |
| `consensus` / three agent participants               | Injected Attempt-port conformance; mixed or unsupported assignments fail before preparation         |
| `choice`, `call`, `parallel`, `repeat`, `map`, `end` | `rn1-control-flow-conformance.test.ts`                                                              |
| duration and signal `wait`                           | `rn1-control-flow-conformance.test.ts`, `raw-kernel-run.test.ts`, and fresh-process signal recovery |
| `humanGate` answer, deadline, cancellation           | `raw-kernel-run.test.ts`                                                                            |

Active-process snapshot recovery and runtime process reaping are host-owned and
therefore outside the `revo-run` evidence map.

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
