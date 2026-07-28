import type { Attempt, Run, RunNodeInstance, RunOutput } from '../../src/domain/index.js';
import type {
  AttemptHandoffState,
  RunStore,
  RunStoreAttemptPage,
  RunStoreAttemptQuery,
  RunStoreCommitCommand,
  RunStoreCommitResult,
  RunStoreDiscoveryCandidate,
  RunStoreDiscoveryPage,
  RunStoreDiscoveryKey,
  RunStoreDiscoveryKind,
  RunStoreDiscoveryQuery,
  RunStoreEventPage,
  RunStoreEventQuery,
  RunStoreIdempotencyIdentity,
  RunStoreIdempotencyRecord,
  RunStoreInvalidInput,
  RunStoreListRunsQuery,
  RunStoreLookupResult,
  RunStoreNodePage,
  RunStoreNodeQuery,
  RunStoreOutputPage,
  RunStoreOutputQuery,
  RunStorePageReadResult,
  RunStoreRunPage,
  RunStoreTransaction,
} from '../../src/storage/index.js';
import {
  applyLogicalRunStoreCommit,
  type LogicalFailureStage,
} from './logical-run-store-commit.js';
import {
  activationIdKey,
  createLogicalRunStoreState,
  handoffKey,
  type LogicalRunStoreState,
  snapshotValue,
} from './logical-run-store-state.js';

const discoveryRanks: Readonly<Record<RunStoreDiscoveryKind, number>> = {
  handoff_attempt: 0,
  expired_attempt: 1,
  renewable_attempt: 2,
  claimable_node: 3,
  cancellation_run: 4,
  progressable_run: 5,
  retiring_attempt: 6,
};

const runStatusRanks = ['running', 'cancelling', 'succeeded', 'failed', 'cancelled'] as const;
const nodeStatusRanks = [
  'ready',
  'executing',
  'retry_waiting',
  'unknown',
  'gate_waiting',
  'join_waiting',
  'succeeded',
  'failed',
  'cancelled',
  'selector_waiting',
  'skipped',
  'retiring',
  'retired',
] as const;
const attemptStatusRanks = [
  'claimed',
  'start_committed',
  'unknown',
  'reconciling',
  'succeeded',
  'failed',
  'cancelled',
] as const;

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

const compareNullableUtf8 = (left: string | null, right: string | null): number => {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareUtf8(left, right);
};

const isCanonicalFilter = <Value>(
  values: readonly Value[],
  rank: (value: Value) => number,
): boolean => {
  if (new Set(values).size !== values.length) return false;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || rank(previous) >= rank(current)) {
      return false;
    }
  }
  return true;
};

const isCanonicalStringFilter = (values: readonly string[]): boolean => {
  if (values.length > 100 || new Set(values).size !== values.length) return false;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || compareUtf8(previous, current) >= 0) {
      return false;
    }
  }
  return true;
};

export const compareDiscoveryKeys = (
  left: RunStoreDiscoveryKey,
  right: RunStoreDiscoveryKey,
): number =>
  left.eligibleAt - right.eligibleAt ||
  discoveryRanks[left.kind] - discoveryRanks[right.kind] ||
  compareUtf8(left.runId, right.runId) ||
  compareNullableUtf8(left.nodeInstanceId, right.nodeInstanceId) ||
  compareNullableUtf8(left.attemptId, right.attemptId);

export const leasePolicyIsValid = (
  transactionNow: number,
  leaseDurationMs: number,
  heartbeatIntervalMs: number,
): boolean =>
  Number.isSafeInteger(transactionNow) &&
  transactionNow >= 0 &&
  Number.isSafeInteger(leaseDurationMs) &&
  leaseDurationMs >= 1_000 &&
  leaseDurationMs <= 86_400_000 &&
  Number.isSafeInteger(heartbeatIntervalMs) &&
  heartbeatIntervalMs >= 100 &&
  heartbeatIntervalMs < leaseDurationMs &&
  Number.isSafeInteger(transactionNow + leaseDurationMs);

const invalidInput = (message: string): RunStoreInvalidInput => ({
  code: 'INVALID_INPUT',
  message,
});

const identityKey = (identity: RunStoreIdempotencyIdentity): string =>
  JSON.stringify([identity.operation, identity.runId, identity.subjectId, identity.key]);

export class LogicalRunStoreFake implements RunStore {
  #state = createLogicalRunStoreState();
  readonly #transactionNow: number;
  #transactionTail: Promise<void> = Promise.resolve();
  #failureStage: LogicalFailureStage | null = null;

  constructor(transactionNow: number) {
    if (!Number.isSafeInteger(transactionNow) || transactionNow < 0) {
      throw new TypeError('Logical Store transaction time must be a nonnegative safe integer.');
    }
    this.#transactionNow = transactionNow;
  }

  seed(values: {
    readonly runs?: readonly Run[];
    readonly nodes?: readonly RunNodeInstance[];
    readonly attempts?: readonly Attempt[];
    readonly outputs?: readonly RunOutput[];
    readonly handoffs?: readonly AttemptHandoffState[];
    readonly idempotency?: readonly {
      readonly lookup: RunStoreIdempotencyIdentity;
      readonly record: RunStoreIdempotencyRecord;
    }[];
  }): void {
    for (const run of values.runs ?? []) this.#state.runs.set(run.id, snapshotValue(run));
    for (const node of values.nodes ?? []) this.#state.nodes.set(node.id, snapshotValue(node));
    for (const attempt of values.attempts ?? []) {
      this.#state.attempts.set(attempt.id, snapshotValue(attempt));
    }
    for (const output of values.outputs ?? []) {
      this.#state.outputs.set(output.id, snapshotValue(output));
    }
    for (const state of values.handoffs ?? []) {
      this.#state.handoffs.set(handoffKey(state.handoff.key), snapshotValue(state));
    }
    for (const entry of values.idempotency ?? []) {
      this.#state.idempotency.set(identityKey(entry.lookup), snapshotValue(entry.record));
    }
  }

  failAfterNextCommit(): void {
    this.#failureStage = 'idempotency';
  }

  failAfterNextStage(stage: LogicalFailureStage): void {
    this.#failureStage = stage;
  }

  async transaction<Result>(
    callback: (transaction: RunStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    const prior = this.#transactionTail;
    let release: () => void = () => undefined;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    let active = true;
    let terminal = false;
    let hasPendingCommit = false;
    const pending: LogicalRunStoreState = {
      attempts: new Map(this.#state.attempts),
      events: new Map([...this.#state.events].map(([runId, events]) => [runId, [...events]])),
      handoffs: new Map(this.#state.handoffs),
      idempotency: new Map(this.#state.idempotency),
      nodes: new Map(this.#state.nodes),
      outputs: new Map(this.#state.outputs),
      runs: new Map(this.#state.runs),
    };

    const ensureActive = (): RunStoreInvalidInput | null =>
      active && !terminal ? null : invalidInput('Transaction is no longer active.');

    const lookupRun = async (runId: string): Promise<RunStoreLookupResult<Run>> => {
      const invalid = ensureActive();
      if (invalid !== null) return { kind: 'invalid_input', fault: invalid };
      const run = pending.runs.get(runId);
      return run === undefined ? { kind: 'not_found' } : { kind: 'found', value: run };
    };

    const commit = async (command: RunStoreCommitCommand): Promise<RunStoreCommitResult> => {
      const invalid = ensureActive();
      if (invalid !== null) return { kind: 'invalid_input', fault: invalid };
      terminal = true;
      const result = applyLogicalRunStoreCommit(pending, command, this.#transactionNow, (stage) => {
        if (stage !== this.#failureStage) return;
        this.#failureStage = null;
        throw new Error(`Injected logical provider failure after ${stage}.`);
      });
      hasPendingCommit = result.kind === 'committed';
      return result;
    };

    const lookup = async <Value>(
      values: ReadonlyMap<string, Value>,
      id: string,
    ): Promise<RunStoreLookupResult<Value>> => {
      const inactive = ensureActive();
      if (inactive !== null) return { kind: 'invalid_input', fault: inactive };
      const value = values.get(id);
      return value === undefined ? { kind: 'not_found' } : { kind: 'found', value };
    };
    const transaction: RunStoreTransaction = {
      transactionNow: this.#transactionNow,
      getRun: lookupRun,
      getNode: async (id) => lookup(pending.nodes, id),
      getNodeByActivation: async (runId, activationId) => {
        const inactive = ensureActive();
        if (inactive !== null) return { kind: 'invalid_input', fault: inactive };
        const key = activationIdKey(runId, activationId);
        const node = [...pending.nodes.values()].find(
          (candidate) => activationIdKey(candidate.runId, candidate.activationId) === key,
        );
        return node === undefined ? { kind: 'not_found' } : { kind: 'found', value: node };
      },
      getAttempt: async (id) => lookup(pending.attempts, id),
      listNodes: async (query) => this.#listNodes(pending, query, ensureActive()),
      listAttempts: async (query) => this.#listAttempts(pending, query, ensureActive()),
      listOutputs: async (query) => this.#listOutputs(pending, query, ensureActive()),
      getIdempotency: async (identity) => {
        const invalid = ensureActive();
        if (invalid !== null) return { kind: 'invalid_input', fault: invalid };
        const record = pending.idempotency.get(identityKey(identity));
        return record === undefined ? { kind: 'not_found' } : { kind: 'found', value: record };
      },
      getHandoff: async (key) => lookup(pending.handoffs, handoffKey(key)),
      commit,
    };
    try {
      const result = await callback(transaction);
      if (hasPendingCommit) {
        this.#state = pending;
      }
      return result;
    } finally {
      active = false;
      release();
    }
  }

  async discover(
    query: RunStoreDiscoveryQuery,
  ): Promise<RunStorePageReadResult<RunStoreDiscoveryPage>> {
    const validation = this.#validateLimit<RunStoreDiscoveryPage>(query.limit);
    if (validation !== null) return validation;
    if (query.kinds.length === 0 || new Set(query.kinds).size !== query.kinds.length) {
      return this.#invalidPage('Discovery kinds must be nonempty and unique.');
    }
    const ranked = [...query.kinds].sort(
      (left, right) => discoveryRanks[left] - discoveryRanks[right],
    );
    if (!query.kinds.every((kind, index) => kind === ranked[index])) {
      return this.#invalidPage('Discovery kinds must use canonical rank order.');
    }
    if (query.kinds.includes('renewable_attempt') !== (query.renewal !== null)) {
      return this.#invalidPage('Renewal discovery configuration does not match kinds.');
    }
    const highWatermark =
      query.scan.kind === 'start' ? this.#transactionNow : query.scan.cursor.highWatermark;
    if (
      query.scan.kind === 'continue' &&
      (JSON.stringify(query.scan.cursor.kinds) !== JSON.stringify(query.kinds) ||
        JSON.stringify(query.scan.cursor.renewal) !== JSON.stringify(query.renewal))
    ) {
      return this.#invalidPage('Discovery continuation filters do not match.');
    }
    const candidates = this.#discoveryCandidates(query, highWatermark)
      .filter((candidate) => candidate.eligibleAt <= highWatermark)
      .sort((left, right) =>
        compareDiscoveryKeys(this.#candidateKey(left), this.#candidateKey(right)),
      );
    const after = query.scan.kind === 'continue' ? query.scan.cursor.last : null;
    const remaining =
      after === null
        ? candidates
        : candidates.filter(
            (candidate) => compareDiscoveryKeys(this.#candidateKey(candidate), after) > 0,
          );
    const items = remaining.slice(0, query.limit);
    const last = items.at(-1);
    return {
      kind: 'page',
      page: {
        highWatermark,
        items,
        next:
          last !== undefined && remaining.length > items.length
            ? {
                highWatermark,
                kinds: query.kinds,
                last: this.#candidateKey(last),
                renewal: query.renewal,
              }
            : null,
      },
    };
  }

  async getRun(runId: string): Promise<RunStoreLookupResult<Run>> {
    const run = this.#state.runs.get(runId);
    return run === undefined ? { kind: 'not_found' } : { kind: 'found', value: run };
  }

  async listRuns(query: RunStoreListRunsQuery): Promise<RunStorePageReadResult<RunStoreRunPage>> {
    const validation = this.#validateLimit<RunStoreRunPage>(query.limit);
    if (validation !== null) return validation;
    if (!isCanonicalFilter(query.statuses, (status) => runStatusRanks.indexOf(status))) {
      return this.#invalidPage('Run statuses must be unique and canonical.');
    }
    const highWatermark =
      query.scan.kind === 'start' ? this.#transactionNow : query.scan.cursor.highWatermark;
    if (
      query.scan.kind === 'continue' &&
      (JSON.stringify(query.scan.cursor.statuses) !== JSON.stringify(query.statuses) ||
        query.scan.cursor.planId !== query.planId)
    ) {
      return this.#invalidPage('Run continuation filters do not match.');
    }
    const cursor = query.scan.kind === 'continue' ? query.scan.cursor : null;
    const matches = [...this.#state.runs.values()]
      .filter(
        (run) =>
          run.createdAt <= highWatermark &&
          (query.statuses.length === 0 || query.statuses.includes(run.status)) &&
          (query.planId === null || run.planPin.id === query.planId) &&
          (cursor === null ||
            run.createdAt < cursor.lastCreatedAt ||
            (run.createdAt === cursor.lastCreatedAt && compareUtf8(run.id, cursor.lastRunId) > 0)),
      )
      .sort((left, right) => right.createdAt - left.createdAt || compareUtf8(left.id, right.id));
    const items = matches.slice(0, query.limit);
    const last = items.at(-1);
    return {
      kind: 'page',
      page: {
        highWatermark,
        items,
        next:
          last !== undefined && matches.length > items.length
            ? {
                highWatermark,
                lastCreatedAt: last.createdAt,
                lastRunId: last.id,
                planId: query.planId,
                statuses: query.statuses,
              }
            : null,
      },
    };
  }

  async readEvents(query: RunStoreEventQuery): Promise<RunStorePageReadResult<RunStoreEventPage>> {
    const validation = this.#validateLimit<RunStoreEventPage>(query.limit);
    if (validation !== null) return validation;
    const events = this.#state.events.get(query.runId) ?? [];
    const after =
      query.scan.kind === 'start' ? query.scan.after.sequence : query.scan.cursor.afterSequence;
    const highWatermark =
      query.scan.kind === 'start'
        ? (events.at(-1)?.sequence ?? 0)
        : query.scan.cursor.highWatermarkSequence;
    const cursorRunId =
      query.scan.kind === 'start' ? query.scan.after.runId : query.scan.cursor.runId;
    if (
      cursorRunId !== query.runId ||
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > highWatermark
    ) {
      return this.#invalidPage('Event cursor is foreign, unsafe, or reversed.');
    }
    const matches = events.filter(
      (event) => event.sequence > after && event.sequence <= highWatermark,
    );
    const items = matches.slice(0, query.limit);
    const last = items.at(-1);
    return {
      kind: 'page',
      page: {
        highWatermark: { runId: query.runId, sequence: highWatermark },
        items,
        next:
          last !== undefined && matches.length > items.length
            ? {
                afterSequence: last.sequence,
                highWatermarkSequence: highWatermark,
                runId: query.runId,
              }
            : null,
      },
    };
  }

  #invalidPage<Page>(message: string, _page?: Page): RunStorePageReadResult<Page> {
    return { fault: invalidInput(message), kind: 'invalid_input' };
  }

  #validateLimit<Page>(limit: number, _page?: Page): RunStorePageReadResult<Page> | null {
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
      ? null
      : this.#invalidPage('Page limit must be a safe integer from 1 through 100.');
  }

  #listNodes(
    state: LogicalRunStoreState,
    query: RunStoreNodeQuery,
    inactive: RunStoreInvalidInput | null,
  ): RunStorePageReadResult<RunStoreNodePage> {
    if (inactive !== null) return { fault: inactive, kind: 'invalid_input' };
    const validation = this.#validateLimit<RunStoreNodePage>(query.limit);
    if (validation !== null) return validation;
    if (
      !isCanonicalFilter(query.statuses, (status) => nodeStatusRanks.indexOf(status)) ||
      !isCanonicalStringFilter(query.nodeKeys)
    ) {
      return this.#invalidPage('Node filters must be unique, bounded, and canonical.');
    }
    if (
      query.cursor !== null &&
      JSON.stringify({
        forkScopeKey: query.cursor.forkScopeKey,
        nodeKeys: query.cursor.nodeKeys,
        runId: query.cursor.runId,
        statuses: query.cursor.statuses,
      }) !==
        JSON.stringify({
          forkScopeKey: query.forkScopeKey,
          nodeKeys: query.nodeKeys,
          runId: query.runId,
          statuses: query.statuses,
        })
    )
      return this.#invalidPage('Node continuation filters do not match.');
    const items = [...state.nodes.values()]
      .filter(
        (node) =>
          node.runId === query.runId &&
          (query.statuses.length === 0 || query.statuses.includes(node.status)) &&
          (query.forkScopeKey === null || node.forkScopeKey === query.forkScopeKey) &&
          (query.nodeKeys.length === 0 || query.nodeKeys.includes(node.nodeKey)) &&
          (query.cursor === null || compareUtf8(node.id, query.cursor.lastNodeInstanceId) > 0),
      )
      .sort((left, right) => compareUtf8(left.id, right.id));
    const pageItems = items.slice(0, query.limit);
    const last = pageItems.at(-1);
    return {
      kind: 'page',
      page: {
        items: pageItems,
        next:
          last !== undefined && items.length > pageItems.length
            ? {
                forkScopeKey: query.forkScopeKey,
                lastNodeInstanceId: last.id,
                nodeKeys: query.nodeKeys,
                runId: query.runId,
                statuses: query.statuses,
              }
            : null,
      },
    };
  }

  #listAttempts(
    state: LogicalRunStoreState,
    query: RunStoreAttemptQuery,
    inactive: RunStoreInvalidInput | null,
  ): RunStorePageReadResult<RunStoreAttemptPage> {
    if (inactive !== null) return { fault: inactive, kind: 'invalid_input' };
    const validation = this.#validateLimit<RunStoreAttemptPage>(query.limit);
    if (validation !== null) return validation;
    if (!isCanonicalFilter(query.statuses, (status) => attemptStatusRanks.indexOf(status))) {
      return this.#invalidPage('Attempt statuses must be unique and canonical.');
    }
    if (
      query.cursor !== null &&
      JSON.stringify({
        managerIncarnationId: query.cursor.managerIncarnationId,
        nodeInstanceId: query.cursor.nodeInstanceId,
        runId: query.cursor.runId,
        statuses: query.cursor.statuses,
      }) !==
        JSON.stringify({
          managerIncarnationId: query.managerIncarnationId,
          nodeInstanceId: query.nodeInstanceId,
          runId: query.runId,
          statuses: query.statuses,
        })
    ) {
      return this.#invalidPage('Attempt continuation filters do not match.');
    }
    const items = [...state.attempts.values()]
      .filter(
        (attempt) =>
          attempt.runId === query.runId &&
          (query.nodeInstanceId === null || attempt.nodeInstanceId === query.nodeInstanceId) &&
          (query.statuses.length === 0 || query.statuses.includes(attempt.status)) &&
          (query.managerIncarnationId === null ||
            attempt.managerIncarnationId === query.managerIncarnationId) &&
          (query.cursor === null || compareUtf8(attempt.id, query.cursor.lastAttemptId) > 0),
      )
      .sort((left, right) => compareUtf8(left.id, right.id));
    const pageItems = items.slice(0, query.limit);
    const last = pageItems.at(-1);
    return {
      kind: 'page',
      page: {
        items: pageItems,
        next:
          last !== undefined && items.length > pageItems.length
            ? {
                lastAttemptId: last.id,
                managerIncarnationId: query.managerIncarnationId,
                nodeInstanceId: query.nodeInstanceId,
                runId: query.runId,
                statuses: query.statuses,
              }
            : null,
      },
    };
  }

  #listOutputs(
    state: LogicalRunStoreState,
    query: RunStoreOutputQuery,
    inactive: RunStoreInvalidInput | null,
  ): RunStorePageReadResult<RunStoreOutputPage> {
    if (inactive !== null) return { fault: inactive, kind: 'invalid_input' };
    const validation = this.#validateLimit<RunStoreOutputPage>(query.limit);
    if (validation !== null) return validation;
    if (!isCanonicalStringFilter(query.names)) {
      return this.#invalidPage('Output names must be unique, bounded, and canonical.');
    }
    if (
      query.cursor !== null &&
      JSON.stringify({
        activationId: query.cursor.activationId,
        attemptId: query.cursor.attemptId,
        names: query.cursor.names,
        nodeInstanceId: query.cursor.nodeInstanceId,
        runId: query.cursor.runId,
      }) !==
        JSON.stringify({
          activationId: query.activationId,
          attemptId: query.attemptId,
          names: query.names,
          nodeInstanceId: query.nodeInstanceId,
          runId: query.runId,
        })
    ) {
      return this.#invalidPage('Output continuation filters do not match.');
    }
    const items = [...state.outputs.values()]
      .filter(
        (output) =>
          output.runId === query.runId &&
          (query.names.length === 0 || query.names.includes(output.name)) &&
          (query.nodeInstanceId === null ||
            ('nodeInstanceId' in output.correlation &&
              output.correlation.nodeInstanceId === query.nodeInstanceId)) &&
          (query.attemptId === null ||
            (output.correlation.kind === 'attempt' &&
              output.correlation.attemptId === query.attemptId)) &&
          (query.activationId === null ||
            ('activationId' in output.correlation &&
              output.correlation.activationId === query.activationId)) &&
          (query.cursor === null || compareUtf8(output.id, query.cursor.lastOutputId) > 0),
      )
      .sort((left, right) => compareUtf8(left.id, right.id));
    const pageItems = items.slice(0, query.limit);
    const last = pageItems.at(-1);
    return {
      kind: 'page',
      page: {
        items: pageItems,
        next:
          last !== undefined && items.length > pageItems.length
            ? {
                activationId: query.activationId,
                attemptId: query.attemptId,
                lastOutputId: last.id,
                names: query.names,
                nodeInstanceId: query.nodeInstanceId,
                runId: query.runId,
              }
            : null,
      },
    };
  }

  #candidateKey(candidate: RunStoreDiscoveryCandidate): RunStoreDiscoveryKey {
    return {
      attemptId: candidate.observedAttempt?.attemptId ?? null,
      eligibleAt: candidate.eligibleAt,
      kind: candidate.kind,
      nodeInstanceId: candidate.observedNode?.nodeInstanceId ?? null,
      runId: candidate.observedRun.runId,
    };
  }

  #discoveryCandidates(
    query: RunStoreDiscoveryQuery,
    highWatermark: number,
  ): RunStoreDiscoveryCandidate[] {
    const candidates: RunStoreDiscoveryCandidate[] = [];
    for (const run of this.#state.runs.values()) {
      const observedRun = { planPin: run.planPin, runId: run.id, runRevision: run.revision };
      if (query.kinds.includes('cancellation_run') && run.status === 'cancelling') {
        candidates.push({
          eligibleAt: run.cancellationRequestedAt ?? run.updatedAt,
          handoffId: null,
          kind: 'cancellation_run',
          observedAttempt: null,
          observedNode: null,
          observedRun,
        });
      }
      if (query.kinds.includes('progressable_run') && run.status === 'running') {
        candidates.push({
          eligibleAt: run.updatedAt,
          handoffId: null,
          kind: 'progressable_run',
          observedAttempt: null,
          observedNode: null,
          observedRun,
        });
      }
      for (const node of this.#state.nodes.values()) {
        if (node.runId !== run.id) continue;
        const observedNode = {
          activeAttemptId: node.activeAttemptId,
          nodeInstanceId: node.id,
          nodeKey: node.nodeKey,
          nodeRevision: node.revision,
        };
        if (
          query.kinds.includes('claimable_node') &&
          (node.status === 'ready' ||
            (node.status === 'retry_waiting' &&
              (node.retryAvailableAt ?? Infinity) <= highWatermark)) &&
          node.activeAttemptId === null
        ) {
          candidates.push({
            eligibleAt: node.retryAvailableAt ?? node.updatedAt,
            handoffId: null,
            kind: 'claimable_node',
            observedAttempt: null,
            observedNode,
            observedRun,
          });
        }
        if (node.activeAttemptId === null) continue;
        const attempt = this.#state.attempts.get(node.activeAttemptId);
        if (
          attempt === undefined ||
          (attempt.status !== 'claimed' &&
            attempt.status !== 'start_committed' &&
            attempt.status !== 'unknown' &&
            attempt.status !== 'reconciling')
        )
          continue;
        const observedAttempt = {
          attemptId: attempt.id,
          attemptRevision: attempt.revision,
          attemptStatus: attempt.status,
          fencingToken: attempt.fencingToken,
          leaseExpiresAt: attempt.leaseExpiresAt,
          managerIncarnationId: attempt.managerIncarnationId,
        };
        if (
          query.kinds.includes('retiring_attempt') &&
          node.status === 'retiring' &&
          attempt.progressionClosedAt !== null
        ) {
          candidates.push({
            eligibleAt: attempt.progressionClosedAt,
            handoffId: null,
            kind: 'retiring_attempt',
            observedAttempt,
            observedNode,
            observedRun,
          });
          continue;
        }
        const handoff = this.#state.handoffs.get(
          handoffKey({
            attemptId: attempt.id,
            incumbentFencingToken: attempt.fencingToken,
          }),
        );
        if (query.kinds.includes('handoff_attempt') && handoff?.consumption === null) {
          candidates.push({
            eligibleAt: handoff.handoff.createdAt,
            handoffId: handoff.handoff.id,
            kind: 'handoff_attempt',
            observedAttempt,
            observedNode,
            observedRun,
          });
        } else if (
          query.kinds.includes('expired_attempt') &&
          attempt.leaseExpiresAt <= highWatermark
        ) {
          candidates.push({
            eligibleAt: attempt.leaseExpiresAt,
            handoffId: null,
            kind: 'expired_attempt',
            observedAttempt,
            observedNode,
            observedRun,
          });
        }
        if (
          query.kinds.includes('renewable_attempt') &&
          query.renewal !== null &&
          handoff === undefined &&
          attempt.managerIncarnationId === query.renewal.managerIncarnationId
        ) {
          const eligibleAt =
            attempt.lastHeartbeatAt + query.renewal.leasePolicy.heartbeatIntervalMs;
          if (eligibleAt <= highWatermark && highWatermark < attempt.leaseExpiresAt) {
            candidates.push({
              eligibleAt,
              handoffId: null,
              kind: 'renewable_attempt',
              observedAttempt,
              observedNode,
              observedRun,
            });
          }
        }
      }
    }
    return candidates;
  }
}
