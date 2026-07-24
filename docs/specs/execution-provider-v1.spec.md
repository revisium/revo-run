# Execution Provider v1

- Status: Stable port contract; no real provider or adapter is shipped.

An ExecutionProvider performs one physical invocation for an exact provider pin.
It may report bounded, redacted observations and reconciliation results. It must
not persist an attempt, select retry policy, determine graph progress, or change
lifecycle state. The controller records every accepted observation through the
EvidenceStore CAS boundary.

A durable observation contains the opaque invocation ID, opaque provider event
ID, and safe-projection digest. Exact duplicate delivery returns the committed
snapshot; the same key with a different projection rejects. A terminal result is
not published before its durable event/record transition commits.

Provider start before durable coordinate may orphan physical work and therefore
requires `recovery_blocked`; cancellation dispatch uncertainty is likewise never
reported as cancelled. Reconciliation uses only stored coordinate and exact pin,
not a PID alone.

## Exact v1 port

```ts
type ProviderErrorV1 = {
  schemaVersion: 'revo-run/provider-error/v1';
  code: 'rejected' | 'timeout' | 'unavailable' | 'protocol_error' | 'uncertain';
  safeProjection: SafeProjectionV1;
};
type ExecutionProviderV1 = {
  prepare(input: {
    attemptId: string;
    executionPin: StartAttemptV1['executionPin'];
    input: JsonValue;
    resultContract: StartAttemptV1['resultContract'];
    limits: StartAttemptV1['limits'];
    deadlineAt: Timestamp;
    signal: AbortSignal;
  }): Promise<{ kind: 'ready' } | { kind: 'rejected'; error: ProviderErrorV1 }>;
  start(input: {
    attemptId: string;
    executionPin: StartAttemptV1['executionPin'];
    deadlineAt: Timestamp;
    signal: AbortSignal;
    onObservation: (x: ProviderObservationV1) => Promise<SnapshotV1>;
  }): Promise<
    | { kind: 'started'; coordinate: ProviderCoordinateV1 }
    | { kind: 'rejected'; error: ProviderErrorV1 }
  >;
  cancel(input: {
    attemptId: string;
    coordinate: ProviderCoordinateV1;
    deadlineAt: Timestamp;
    signal: AbortSignal;
  }): Promise<{ kind: 'accepted' } | { kind: 'rejected'; error: ProviderErrorV1 }>;
  reconcile(input: {
    attemptId: string;
    executionPin: StartAttemptV1['executionPin'];
    coordinate: ProviderCoordinateV1;
    deadlineAt: Timestamp;
    signal: AbortSignal;
  }): Promise<
    | { kind: 'running' }
    | { kind: 'terminal'; observation: ProviderObservationV1 }
    | { kind: 'missing' }
    | { kind: 'uncertain'; error: ProviderErrorV1 }
  >;
};
```

RunController computes deadline once from wallClockMs; provider stops at signal
or deadline and cannot extend it. prepare has no physical effect; start creates
at most one invocation; controller persists coordinate before accepting callback;
cancel occurs at most once after coordinate commit. Provider receives no store,
retry policy, pipeline, secrets, mutable registry, or transition function. It
reports facts only and controller maps them through the lifecycle table.
