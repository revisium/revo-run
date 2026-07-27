# Consumer example

> Draft only. `@revisium/revo-run` currently exports no product API.
> Architecture validation is active.

The host injects infrastructure. `RunManager` owns the durable execution and
observation lifecycle; there is no host `RunWorker`.

## Exact plan document

The public plan source returns package-owned JSON-compatible data:

```ts
import type { ExecutionPlanSource } from '@revisium/revo-run';

const plans: ExecutionPlanSource = {
  async loadExact(pin) {
    const document = await planRepository.findExact(pin);
    if (!document) {
      return {
        kind: 'fault',
        fault: { code: 'NOT_FOUND', message: 'Exact execution plan was not found.' },
      };
    }

    return {
      kind: 'loaded',
      planDocument: snapshotImmutablePlanDocument({
        pin: document.pin,
        compiledPipeline: document.compiledPipeline,
        executorBindings: document.nodes.map((node) => ({
          nodeKey: node.key,
          executor: {
            adapterId: node.executor.adapterId,
            revision: node.executor.revision,
            digest: node.executor.contractDigest,
          },
          configuration: node.executor.configuration,
          configurationDigest: node.executor.configurationDigest,
          idempotentExecution: node.executor.idempotentExecution,
          retryPolicy: node.retryPolicy,
          timeoutPolicy: node.timeoutPolicy,
        })),
      }),
    };
  },
};
```

`compiledPipeline` is `JsonValue`. The source does not import pipeline types or
cast JSON to a compiled pipeline. Only private package
`lifecycle/pipeline/**` modules use the future public pipeline decoder; the
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

```ts
import { createRunManager } from '@revisium/revo-run';

const runs = createRunManager({
  store: postgresRunStore,
  plans,
  executors,
  ids: {
    nextId: () => crypto.randomUUID(),
  },
  clock: localClock,
  coordination: {
    ownerLabel: process.env.INSTANCE_NAME ?? 'local',
    maxConcurrentExecutions: 8,
    pollIntervalMs: 250,
    heartbeatIntervalMs: 10_000,
    leaseDurationMs: 30_000,
    drainTimeoutMs: 30_000,
  },
});
```

`ownerLabel` is diagnostic. Each `start()` creates a unique package-owned
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
  answer: {
    name: 'human-answer',
    type: 'application/json',
    value: structuredClone(request.answer),
  },
  actor: {
    type: 'user',
    id: request.userId,
  },
  idempotencyKey: request.id,
});
```

The answer targets one runtime activation and commits with gate progression.

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
          type: 'application/json',
          value: response.receipt,
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
