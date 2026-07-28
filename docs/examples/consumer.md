# Consumer example

> Draft only. `@revisium/revo-run` currently exports no product API.
> Architecture validation is active.

The host injects infrastructure. `RunManager` owns the durable execution and
observation lifecycle; there is no host `RunWorker`.

## Exact plan document

The host loader returns JSON-compatible data. A future package-private
`ExecutionPlanSource` adapter snapshots it into the package-owned exact plan
document; that private port is intentionally not imported from the public root:

```ts
const loadExactPlanDocument = async (pin: HostPlanPin) => {
  const document = await planRepository.findExact(pin);
  if (!document) {
    return {
      kind: 'fault' as const,
      fault: { code: 'NOT_FOUND' as const, message: 'Exact execution plan was not found.' },
    };
  }

  return {
    kind: 'loaded' as const,
    planDocument: {
      pin: document.pin,
      compiledPipeline: structuredClone(document.compiledPipeline),
      terminalBindings: document.terminals.map((terminal) => ({
        nodeKey: terminal.nodeKey,
        outcome: terminal.outcome,
        status: terminal.status,
        ...(terminal.status === 'failed'
          ? {
              fault: {
                code: 'PIPELINE_TERMINAL' as const,
                message: terminal.failureMessage,
              },
            }
          : {}),
      })),
      executorBindings: document.nodes.map((node) => ({
        nodeKey: node.key,
        executor: {
          adapterId: node.executor.adapterId,
          revision: node.executor.revision,
          digest: node.executor.contractDigest,
        },
        configuration: structuredClone(node.executor.configuration),
        configurationDigest: node.executor.configurationDigest,
        idempotentExecution: node.executor.idempotentExecution,
        retryPolicy: node.retryPolicy,
        timeoutPolicy: node.timeoutPolicy,
      })),
    },
  };
};
```

The future private adapter applies the package's bounded immutable snapshot
validation to this result:

```ts
const plans = {
  async loadExact(pin: HostPlanPin) {
    const loaded = await loadExactPlanDocument(pin);
    return loaded.kind === 'fault'
      ? loaded
      : {
          kind: 'loaded' as const,
          planDocument: snapshotPackageOwnedPlanDocument({
            ...loaded.planDocument,
            // The private adapter validates terminal bindings as part of the
            // exact package-owned document before lifecycle reduction.
            terminalBindings: loaded.planDocument.terminalBindings,
          }),
        };
  },
};
```

`compiledPipeline` is `JsonValue`. The source does not import pipeline types or
cast JSON to a compiled pipeline. Only private package
`lifecycle/pipeline/**` modules use the public pipeline decoder/reducer; the
public lifecycle facade stays pipeline-free.

## Exact executor resolution

```ts
const executors = {
  async resolveExact(pin) {
    const executor = executorRegistry.find({
      adapterId: pin.adapterId,
      revision: pin.revision,
      digest: pin.digest,
    });

    if (!executor) throw new ExecutorContractNotFoundFault(pin);
    return executor;
  },
};
```

The resolver never falls back to latest or compatible behavior. Attempts
persist the exact contract pin and configuration digest for restart recovery.

## Compose one manager

The final public composition/options shape is deferred. The host will provide a
concrete Store adapter, the exact plan loader illustrated above, executor
resolution, and purpose-specific identifier callbacks. Package-private
composition will adapt the host loader to `ExecutionPlanSource`; consumers will
not import that private type.

The currently implemented `ManagerIdSource` contract has exactly five
purpose-specific methods: `nextManagerIncarnationId`, `nextAttemptId`,
`nextHandoffId`, `nextOutputId`, and `nextLifecycleIdempotencyKey`. Future
progression coordination may require additional caller-supplied allocation
values, but their public composition API is not defined by this contracts
slice.

`ownerLabel` remains diagnostic. Each `start()` creates a unique package-owned
manager incarnation, persisted on claimed Attempts. `clock` schedules local
wakeups only; the store supplies authoritative transaction time.

## Start and stop

```ts
await runs.start();

process.once('SIGTERM', () => {
  void runs.stop({ drain: true });
});
```

Start moves through `starting` recovery into `running`. Stop moves through
`quiescing` and `draining`: no new claims, while heartbeats and fenced result
commits continue. Timeout aborts local work only after lifecycle commits an
explicit durable handoff under the active incarnation/fence. After stopped,
late executor promises cannot write.

## Start a run

```ts
const run = await runs.startRun({
  plan: {
    id: request.planId,
    revision: request.planRevision,
    digest: request.planDigest,
  },
  input: structuredClone(request.input),
  idempotencyKey: request.id,
  actor: {
    type: 'user',
    id: request.userId,
  },
});
```

The manager loads and verifies the exact document, decodes pipeline JSON inside
lifecycle, and persists only the plan pin with durable run state.

## Pull durable progress

```ts
const subscription = await runs.subscribe({
  runId: run.id,
  after: request.lastSeenCursor,
  pageSize: 50,
});

try {
  await projectionStore.apply(subscription.initial.snapshot, [], subscription.initial.cursor);

  if (!subscription.initial.snapshot.terminal) {
    for await (const item of subscription) {
      await projectionStore.apply(item.snapshot, item.events, item.cursor);
    }
  }
} finally {
  await subscription.close();
}
```

Subscription creation exposes a consistent snapshot plus event high watermark
as `subscription.initial`. Each pulled item/page has a durable resume cursor,
is strictly after `subscription.initial.cursor`, and has bounded size. Consumer
pull supplies backpressure. A terminal initial snapshot means iteration is
already complete. When a pulled item is terminal, the iterator completes
immediately after yielding that item.

Terminal waiting uses the same protocol:

```ts
const terminal = await runs.waitForTerminal({
  runId: run.id,
  after: request.lastSeenCursor,
  signal: request.signal,
  timeoutMs: 15 * 60_000,
});
```

## Answer a human gate

```ts
await runs.answerGate({
  runId: inboxItem.runId,
  activationId: inboxItem.activationId,
  resolution: request.resolution,
  values: request.progressionValues,
  answerOutput: {
    kind: 'json',
    value: structuredClone(request.answer),
  },
  actor: {
    type: 'user',
    id: request.userId,
  },
  idempotencyKey: request.id,
});
```

The answer targets one runtime activation. Its normalized resolution and
explicit scalar progression values are distinct from the arbitrary immutable
answer output; all commit atomically with gate progression.

## Executor protocol

An internal claim commits Attempt phase `claimed`, manager incarnation, fence,
lease, exact executor pin, and configuration digest. The manager resolves that
exact executor and verifies the immutable configuration digest. A separate
internal Start CAS then obtains fresh database time and commits
`start_committed`. Only then does the manager call:

```ts
const paymentExecutor = {
  async execute(input) {
    const response = await payments.charge({
      paymentId: input.executionId,
      amount: input.payload.amount,
      signal: input.signal,
    });

    return {
      kind: 'succeeded',
      outputs: [
        {
          name: 'receipt',
          payload: {
            kind: 'json',
            value: response.receipt,
          },
        },
      ],
    };
  },

  async reconcile(input) {
    const payment = await payments.findById(input.executionId);
    if (!payment) return { kind: 'unknown' };
    return payment.succeeded
      ? { kind: 'succeeded', outputs: [receiptOutput(payment.receipt)] }
      : { kind: 'failed', fault: paymentRejectedFault() };
  },

  async cancel(input) {
    return payments.cancel(input.executionId);
  },
};
```

Start, heartbeat, direct result, reconciled result, and cancellation result are
accepted only for current incarnation/fence while
`transactionNow < leaseExpiresAt`. Recovery takeover is permitted only when
database transaction time reaches expiry or the incumbent committed an explicit
durable handoff under its active fence. A lost started execution is unknown;
after eligible takeover, recovery acquires a new incarnation/fence, resolves
the exact executor/configuration, and then reconciles.

## Fork and join

Node snapshots carry causal fork scope. A join considers predecessor node
instances only from its matching scope. Repeated or nested fork activations
cannot satisfy one another's join.

## Host boundary

The host may expose GraphQL, MCP, CLI, or HTTP over the facade. It does not poll
attempt commands, calculate leases/fences, decode pipeline JSON, retry unknown
work, progress joins/gates, or implement a `RunWorker`.
