# Pipeline Adapter v1 — Phase 2 design only

- Status: Design only. This is not a Phase-1 export, implementation, or dependency.

`PipelineAttemptStartV1` contains its version, pipeline run/step/attempt identity,
one `StartAttemptV1`, and exact execution-plan digest.
`PipelineAttemptTerminalV1` contains version, pipeline identities, attempt ID,
committed terminal result, evidence digest, and revision. A future adapter maps
one verified immutable plan to one start and consumes one committed terminal via
a future public Pipeline API.

The future durable receipt key is `(pipelineRunId, pipelineStepId, attemptId,
committedRevision)`, bound to canonical terminal/evidence digests. Exact replay
returns the original receipt without a second graph transition; a changed digest
rejects a conflict and performs no transition. Only an accepted Pipeline receipt
may advance a graph. The adapter cannot choose retry, mutate kernel lifecycle,
resolve a gate, or select a node; the kernel cannot interpret pipeline step data,
call callbacks, or persist graph state.

Implementation waits for versioned installed Pipeline exports with defined
idempotency/errors and two-package tarball consumer tests.

## Exact Phase-2-only shapes

```ts
type PipelineAttemptStartV1 = {
  schemaVersion: 'revo-run/pipeline-attempt-start/v1';
  pipelineRunId: string;
  pipelineStepId: string;
  pipelineAttemptNo: SafeInt;
  executionPlanDigest: Sha256;
  start: StartAttemptV1;
};
type PipelineAttemptTerminalV1 = {
  schemaVersion: 'revo-run/pipeline-attempt-terminal/v1';
  pipelineRunId: string;
  pipelineStepId: string;
  pipelineAttemptNo: SafeInt;
  attemptId: `rra_${UuidV7}`;
  committedRevision: SafeInt;
  terminal: TerminalResultV1;
  terminalDigest: Sha256;
  evidenceDigest: Sha256;
};
type PipelineReceiptV1 = {
  schemaVersion: 'revo-run/pipeline-receipt/v1';
  pipelineRunId: string;
  pipelineStepId: string;
  attemptId: `rra_${UuidV7}`;
  committedRevision: SafeInt;
  terminalDigest: Sha256;
  evidenceDigest: Sha256;
  receiptId: string;
  receivedAt: Timestamp;
};
```

Pipeline IDs and receiptId are opaque safe strings 1..128; pipelineAttemptNo and
committedRevision are >=1. Receipt key `(pipelineRunId,pipelineStepId,attemptId,
committedRevision)` binds terminal/evidence digests. Exact repeat returns the
original receipt; changed digest conflicts. A future public Pipeline API
atomically creates receipt and its one graph transition. Neither revo-run nor
the adapter routes the graph. These shapes create no Phase-1 export, callback,
dependency, or implementation.
