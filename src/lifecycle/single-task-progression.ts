import {
  applyRunProgression,
  createRun,
  type Attempt,
  type Run,
  type RunNodeInstance,
  type RunOutput,
  type RunProgressionAppliedReceipt,
} from '../domain/index.js';
import {
  canonicalizeJson,
  snapshotPortableJsonValue,
  snapshotRunProgressionAppliedReceipt,
  snapshotRunExecutionPlanDocument,
} from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type {
  RunStore,
  RunStoreAttemptExpectation,
  RunStoreIdempotencyIdentity,
  RunStoreNodeExpectation,
  RunStoreRunExpectation,
  RunStoreTransaction,
} from '../storage/index.js';
import type { LifecycleInitializeSingleTaskRunRequest } from './lifecycle-initialize-single-task-run-request.js';
import type { LifecycleProgressSingleTaskOutcomeRequest } from './lifecycle-progress-single-task-outcome-request.js';
import type { LifecycleSingleTaskProgressionResult } from './lifecycle-single-task-progression-result.js';
import { singleTaskPlanReducer } from './pipeline/reduce-single-task-plan.js';

const fault = (
  code:
    | 'INVALID_INPUT'
    | 'NOT_FOUND'
    | 'PLAN_MISMATCH'
    | 'PLAN_INVALID'
    | 'PROGRESSION_STATE_INVALID',
  message: string,
): LifecycleSingleTaskProgressionResult => ({
  kind: 'fault',
  fault: { code, message },
});

const jsonRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface DeferredInitializationReplay {
  readonly kind: 'deferred_replay';
  readonly receipt: JsonValue;
  readonly runId: string;
}

const mapError = (error: unknown): LifecycleSingleTaskProgressionResult => {
  if (error instanceof TypeError && error.message === 'PLAN_UNSUPPORTED') {
    return fault('PLAN_INVALID', 'PLAN_UNSUPPORTED');
  }
  if (error instanceof TypeError && error.message === 'PLAN_INVALID') {
    return fault('PLAN_INVALID', 'Execution plan is invalid.');
  }
  return fault('PROGRESSION_STATE_INVALID', 'Run progression state is invalid.');
};

const runExpectation = (run: Run): RunStoreRunExpectation => ({
  planPin: run.planPin,
  revision: run.revision,
  runId: run.id,
});

const nodeExpectation = (node: RunNodeInstance): RunStoreNodeExpectation => ({
  activeAttemptId: node.activeAttemptId,
  nodeInstanceId: node.id,
  revision: node.revision,
});

const attemptExpectation = (attempt: Attempt): RunStoreAttemptExpectation => ({
  attemptId: attempt.id,
  fencingToken: attempt.fencingToken,
  handoff: {
    key: { attemptId: attempt.id, incumbentFencingToken: attempt.fencingToken },
    kind: 'absent',
  },
  leaseExpiresAt: attempt.leaseExpiresAt,
  managerIncarnationId: attempt.managerIncarnationId,
  revision: attempt.revision,
  status: attempt.status,
});

const replay = async (
  transaction: RunStoreTransaction,
  identity: RunStoreIdempotencyIdentity,
  request: JsonValue,
): Promise<LifecycleSingleTaskProgressionResult | null> => {
  const found = await transaction.getIdempotency(identity);
  if (found.kind === 'invalid_input')
    return fault('INVALID_INPUT', 'Lifecycle request is invalid.');
  if (found.kind === 'not_found') return null;
  if (canonicalizeJson(found.value.request) !== canonicalizeJson(request)) {
    return {
      kind: 'conflict',
      conflict: { code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was reused.' },
    };
  }
  const loaded = await transaction.getRun(identity.runId ?? '');
  if (loaded.kind !== 'found') return fault('NOT_FOUND', 'Run is not available.');
  try {
    return {
      kind: 'replayed',
      receipt: snapshotRunProgressionAppliedReceipt(found.value.result),
      run: loaded.value,
    };
  } catch {
    return fault('PROGRESSION_STATE_INVALID', 'Stored progression receipt is invalid.');
  }
};

const replayInitialization = async (
  transaction: RunStoreTransaction,
  identity: RunStoreIdempotencyIdentity,
  request: JsonValue,
): Promise<LifecycleSingleTaskProgressionResult | null> => {
  const found = await transaction.getIdempotency(identity);
  if (found.kind === 'invalid_input')
    return fault('INVALID_INPUT', 'Lifecycle request is invalid.');
  if (found.kind === 'not_found') return null;
  if (canonicalizeJson(found.value.request) !== canonicalizeJson(request)) {
    return {
      kind: 'conflict',
      conflict: { code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was reused.' },
    };
  }
  const result = found.value.result;
  if (
    !jsonRecord(result) ||
    typeof result['runId'] !== 'string' ||
    result['receipt'] === undefined
  ) {
    return fault('PROGRESSION_STATE_INVALID', 'Stored initialization receipt is invalid.');
  }
  const loaded = await transaction.getRun(result['runId']);
  if (loaded.kind !== 'found') return fault('NOT_FOUND', 'Run is not available.');
  try {
    return {
      kind: 'replayed',
      receipt: snapshotRunProgressionAppliedReceipt(result['receipt']),
      run: loaded.value,
    };
  } catch {
    return fault('PROGRESSION_STATE_INVALID', 'Stored initialization receipt is invalid.');
  }
};

const mapCommit = (
  result: Awaited<ReturnType<RunStoreTransaction['commit']>>,
  run: Run,
  receipt: RunProgressionAppliedReceipt,
): LifecycleSingleTaskProgressionResult => {
  if (result.kind === 'committed') return { kind: 'committed', receipt, run };
  if (result.kind === 'replayed') {
    return {
      kind: 'replayed',
      receipt: snapshotRunProgressionAppliedReceipt(result.record.result),
      run,
    };
  }
  if (result.kind === 'conflict') return { kind: 'conflict', conflict: result.conflict };
  return fault('INVALID_INPUT', 'Store rejected lifecycle input.');
};

const initializeSingleTaskRun = (
  store: RunStore,
  input: LifecycleInitializeSingleTaskRunRequest,
): Promise<LifecycleSingleTaskProgressionResult> => {
  let request: LifecycleInitializeSingleTaskRunRequest;
  try {
    request = {
      ...input,
      input: snapshotPortableJsonValue(input.input),
      planDocument: snapshotRunExecutionPlanDocument(input.planDocument),
    };
  } catch {
    return Promise.resolve(fault('INVALID_INPUT', 'Lifecycle request is invalid.'));
  }
  const identity = {
    key: request.idempotencyKey,
    operation: 'start_run' as const,
    runId: null,
    subjectId: null,
  };
  const semanticRequest = snapshotPortableJsonValue({
    input: request.input,
    operation: 'initialize',
    planPin: request.planDocument.pin,
  });
  return store
    .transaction<LifecycleSingleTaskProgressionResult | DeferredInitializationReplay>(
      async (transaction) => {
        const prior = await replayInitialization(transaction, identity, semanticRequest);
        if (prior !== null) return prior;
        const draft = createRun({
          cancellationRequestedAt: null,
          createdAt: transaction.transactionNow,
          id: request.runId,
          input: request.input,
          planPin: request.planDocument.pin,
          progression: {
            candidateVerdicts: [],
            commandReceipts: [],
            gateResolutions: [],
            nodes: [],
            occurrenceKey: request.occurrenceKey,
            phase: 'uninitialized',
            schemaVersion: 1,
            terminal: null,
            values: [],
          },
          revision: 0,
          status: 'running',
          terminalAt: null,
          terminalFault: null,
          updatedAt: transaction.transactionNow,
        });
        let transition;
        try {
          transition = applyRunProgression({
            intent: singleTaskPlanReducer.reduceInitialization({
              allocation: singleTaskPlanReducer.deriveAllocation(request.allocationSeed),
              document: request.planDocument,
              occurrenceKey: request.occurrenceKey,
              projection: { attempts: [], nodes: [], outputs: [], run: draft },
              transactionNow: transaction.transactionNow,
            }),
            projection: { attempts: [], nodes: [], outputs: [], run: draft },
            transactionNow: transaction.transactionNow,
          });
        } catch (error) {
          return mapError(error);
        }
        const createdNode = transition.nodes[0];
        if (createdNode === undefined)
          return fault('PROGRESSION_STATE_INVALID', 'Initialization did not activate a task.');
        const receipt = transition.run.progression.commandReceipts[0]!.result;
        const result = await transaction.commit({
          expected: {
            absentNodes: [
              {
                activationId: createdNode.activationId,
                activationKey: createdNode.activationKey,
                forkScopeKey: createdNode.forkScopeKey,
                nodeInstanceId: createdNode.id,
                runId: createdNode.runId,
              },
            ],
            absentOutputIds: [],
            absentRunId: request.runId,
          },
          idempotency: {
            identity,
            request: semanticRequest,
            result: { receipt, runId: transition.run.id },
          },
          eventIntents: transition.eventIntents,
          kind: 'create_run',
          nodes: transition.nodes,
          outputs: transition.outputs,
          run: transition.run,
        });
        if (result.kind === 'committed') {
          return { kind: 'committed' as const, receipt, run: transition.run };
        }
        if (result.kind === 'replayed') {
          const replayResult = result.record.result;
          if (
            !jsonRecord(replayResult) ||
            typeof replayResult['runId'] !== 'string' ||
            replayResult['receipt'] === undefined
          ) {
            return fault('PROGRESSION_STATE_INVALID', 'Stored initialization receipt is invalid.');
          }
          return {
            kind: 'deferred_replay' as const,
            receipt: replayResult['receipt'],
            runId: replayResult['runId'],
          };
        }
        if (result.kind === 'conflict') return { kind: 'conflict', conflict: result.conflict };
        return fault('INVALID_INPUT', 'Store rejected lifecycle input.');
      },
    )
    .then(async (result) => {
      if (result.kind !== 'deferred_replay') return result;
      const loaded = await store.getRun(result.runId);
      if (loaded.kind !== 'found') return fault('NOT_FOUND', 'Run is not available.');
      try {
        return {
          kind: 'replayed',
          receipt: snapshotRunProgressionAppliedReceipt(result.receipt),
          run: loaded.value,
        };
      } catch {
        return fault('PROGRESSION_STATE_INVALID', 'Stored initialization receipt is invalid.');
      }
    });
};

const loadProjection = async (
  transaction: RunStoreTransaction,
  request: LifecycleProgressSingleTaskOutcomeRequest,
): Promise<{
  readonly run: Run;
  readonly node: RunNodeInstance;
  readonly attempt: Attempt;
  readonly outputs: readonly RunOutput[];
} | null> => {
  const [run, node, attempt, outputs] = await Promise.all([
    transaction.getRun(request.authority.runId),
    transaction.getNode(request.authority.nodeInstanceId),
    transaction.getAttempt(request.authority.attemptId),
    transaction.listOutputs({
      activationId: null,
      attemptId: null,
      cursor: null,
      limit: 100,
      names: [],
      nodeInstanceId: null,
      runId: request.authority.runId,
    }),
  ]);
  if (
    run.kind !== 'found' ||
    node.kind !== 'found' ||
    attempt.kind !== 'found' ||
    outputs.kind !== 'page' ||
    outputs.page.next !== null
  )
    return null;
  return { attempt: attempt.value, node: node.value, outputs: outputs.page.items, run: run.value };
};

const progressSingleTaskOutcome = (
  store: RunStore,
  request: LifecycleProgressSingleTaskOutcomeRequest,
): Promise<LifecycleSingleTaskProgressionResult> => {
  const identity = {
    key: request.idempotencyKey,
    operation: 'task_outcome_progression' as const,
    runId: request.authority.runId,
    subjectId: request.authority.attemptId,
  };
  const semanticRequest = snapshotPortableJsonValue({
    observation: request.observation,
    operation: 'task_outcome',
    planPin: request.planDocument.pin,
  });
  return store.transaction(async (transaction) => {
    const prior = await replay(transaction, identity, semanticRequest);
    if (prior !== null) return prior;
    const projection = await loadProjection(transaction, request);
    if (projection === null) return fault('NOT_FOUND', 'Run authority is not available.');
    if (canonicalizeJson(projection.run.planPin) !== canonicalizeJson(request.planDocument.pin)) {
      return fault('PLAN_MISMATCH', 'Execution plan pin does not match the Run.');
    }
    let transition;
    try {
      transition = applyRunProgression({
        intent: singleTaskPlanReducer.reduceOutcome({
          allocation: singleTaskPlanReducer.deriveAllocation(request.allocationSeed),
          document: request.planDocument,
          observation: request.observation,
          projection: {
            attempts: [projection.attempt],
            nodes: [projection.node],
            outputs: projection.outputs,
            run: projection.run,
          },
          transactionNow: transaction.transactionNow,
        }),
        projection: {
          attempts: [projection.attempt],
          nodes: [projection.node],
          outputs: projection.outputs,
          run: projection.run,
        },
        transactionNow: transaction.transactionNow,
      });
    } catch (error) {
      return mapError(error);
    }
    const receipt = transition.run.progression.commandReceipts.at(-1)?.result;
    if (receipt === undefined)
      return fault('PROGRESSION_STATE_INVALID', 'Progression receipt is absent.');
    const newNodes = transition.nodes.filter((node) => node.id !== projection.node.id);
    const result = await transaction.commit({
      expected: {
        kind: 'transition',
        value: {
          absentAttemptIds: [],
          absentNodes: newNodes.map((node) => ({
            activationId: node.activationId,
            activationKey: node.activationKey,
            forkScopeKey: node.forkScopeKey,
            nodeInstanceId: node.id,
            runId: node.runId,
          })),
          absentOutputIds: transition.outputs.map((output) => output.id),
          attempts: [attemptExpectation(projection.attempt)],
          nodes: [nodeExpectation(projection.node)],
          run: runExpectation(projection.run),
        },
      },
      idempotency: { identity, request: semanticRequest, result: receipt },
      kind: 'apply_progression_transition',
      operation: 'task_outcome',
      transition,
      trigger: {
        authority: {
          attemptId: request.authority.attemptId,
          executorConfigurationDigest: request.authority.executorConfigurationDigest,
          executorContractPin: request.authority.executorContractPin,
          expectedAttemptRevision: request.authority.expectedAttemptRevision,
          expectedNodeRevision: request.authority.expectedNodeRevision,
          expectedRunRevision: request.authority.expectedRunRevision,
          fencingToken: request.authority.fencingToken,
          managerIncarnationId: request.authority.managerIncarnationId,
        },
        kind: 'incumbent_attempt',
      },
    });
    return mapCommit(result, transition.run, receipt);
  });
};

export const singleTaskProgression = Object.freeze({
  initialize: initializeSingleTaskRun,
  progressOutcome: progressSingleTaskOutcome,
});
