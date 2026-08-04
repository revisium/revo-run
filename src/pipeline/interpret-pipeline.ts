import { createHash } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  decidePipeline,
  type CandidateKey,
  type CandidateVerdict,
  type JsonValue,
  type NodeFact,
  type NodeKey,
  type PipelineFacts,
  type TerminalNode,
} from '@revisium/revo-pipeline';

import type {
  ExecutionInvocation,
  ExecutionPlan,
  ExecutionResult,
  ReconcileResult,
  RunErrorCode,
  RunExecutor,
} from '../types.js';

export const RUN_TERMINAL_ENVELOPE = 'revo-run.terminal.v1';
const DEFAULT_EXECUTION_FAILURE_MESSAGE = 'Run execution failed.';
const MAX_EXECUTION_FAILURE_MESSAGE_LENGTH = 512;

export const normalizeExecutionFailureMessage = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value.slice(0, MAX_EXECUTION_FAILURE_MESSAGE_LENGTH);
};

export type RunTerminalEnvelope =
  | {
      readonly kind: typeof RUN_TERMINAL_ENVELOPE;
      readonly status: 'succeeded';
      readonly result: JsonValue;
    }
  | {
      readonly kind: typeof RUN_TERMINAL_ENVELOPE;
      readonly status: 'failed';
      readonly error:
        | { readonly code: 'execution_failed'; readonly message: string }
        | { readonly code: 'invalid_workflow_state' };
    }
  | { readonly kind: typeof RUN_TERMINAL_ENVELOPE; readonly status: 'cancelled' };

export class RunInterpretationError extends Error {
  readonly code: 'execution_failed' | 'invalid_workflow_state';

  constructor(code: 'execution_failed' | 'invalid_workflow_state', message: string) {
    super(
      code === 'execution_failed'
        ? (normalizeExecutionFailureMessage(message) ?? DEFAULT_EXECUTION_FAILURE_MESSAGE)
        : message,
    );
    this.code = code;
  }
}

const invalidState = (message: string): never => {
  throw new RunInterpretationError('invalid_workflow_state', message);
};

const frameExecutionId = (...components: readonly string[]): string => {
  const hash = createHash('sha256');
  for (const component of components) {
    const bytes = Buffer.from(component);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return `revo-run-execution-${hash.digest('hex')}`;
};

export const taskExecutionId = (runId: string, nodeKey: NodeKey): string =>
  frameExecutionId(runId, 'task', nodeKey);

export const candidateExecutionId = (
  runId: string,
  nodeKey: NodeKey,
  candidateKey: CandidateKey,
): string => frameExecutionId(runId, 'candidate', nodeKey, candidateKey);

const isCandidateVerdict = (value: unknown): value is CandidateVerdict['verdict'] =>
  value === 'approve' || value === 'reject' || value === 'abstain';

const normalizeExecutionResult = (value: unknown): ExecutionResult => {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return { status: 'outcome_unknown' };
  }
  if (value.status === 'outcome_unknown') {
    return { status: 'outcome_unknown' };
  }
  if (value.status === 'failed') {
    if (!('error' in value) || typeof value.error !== 'object' || value.error === null) {
      return { status: 'outcome_unknown' };
    }
    const message =
      'message' in value.error ? normalizeExecutionFailureMessage(value.error.message) : undefined;
    if (
      !('code' in value.error) ||
      value.error.code !== 'execution_failed' ||
      message === undefined
    ) {
      return { status: 'outcome_unknown' };
    }
    return { status: 'failed', error: { code: 'execution_failed', message } };
  }
  if (value.status !== 'completed' || !('completion' in value)) {
    return { status: 'outcome_unknown' };
  }
  const completion: unknown = value.completion;
  if (typeof completion !== 'object' || completion === null || !('kind' in completion)) {
    return { status: 'outcome_unknown' };
  }
  if (completion.kind === 'task') {
    return { status: 'completed', completion: { kind: 'task' } };
  }
  if (
    completion.kind === 'candidate' &&
    'verdict' in completion &&
    isCandidateVerdict(completion.verdict)
  ) {
    return {
      status: 'completed',
      completion: { kind: 'candidate', verdict: completion.verdict },
    };
  }
  return { status: 'outcome_unknown' };
};

const normalizeReconcileResult = (value: unknown): ReconcileResult => {
  if (typeof value === 'object' && value !== null && 'status' in value) {
    if (value.status === 'running') {
      return { status: 'running' };
    }
    if (value.status === 'not_found') {
      return { status: 'not_found' };
    }
  }
  return normalizeExecutionResult(value);
};

const reconcileAndMaybeExecute = async (
  executor: RunExecutor,
  invocation: ExecutionInvocation,
): Promise<ReconcileResult> => {
  let reconciled: ReconcileResult;
  try {
    reconciled = normalizeReconcileResult(await executor.reconcile(invocation));
  } catch {
    return { status: 'outcome_unknown' };
  }
  if (reconciled.status !== 'not_found') {
    return reconciled;
  }
  try {
    return normalizeExecutionResult(await executor.execute(invocation));
  } catch {
    return { status: 'outcome_unknown' };
  }
};

type SettledExecutionResult = Exclude<ExecutionResult, { readonly status: 'outcome_unknown' }>;

const settleExecution = async (
  executor: RunExecutor,
  invocation: ExecutionInvocation,
): Promise<SettledExecutionResult> => {
  for (let checkpoint = 0; ; checkpoint += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each bounded external check is durably checkpointed
    const result = await DBOS.runStep(() => reconcileAndMaybeExecute(executor, invocation), {
      name: `settle-${invocation.executionId}`,
    });
    if (result.status === 'completed' || result.status === 'failed') {
      return result;
    }
    // oxlint-disable-next-line no-await-in-loop -- nonterminal checkpoints use durable capped backoff
    await DBOS.sleepms(Math.min(100 * 2 ** Math.min(checkpoint, 6), 5_000));
  }
};

const indexRequirements = (executionPlan: ExecutionPlan) => {
  const taskKeys = new Set(
    executionPlan.pipeline.nodes.filter(({ kind }) => kind === 'task').map(({ key }) => key),
  );
  const requirements = new Map<NodeKey, ExecutionPlan['executorRequirements'][number]>();
  for (const requirement of executionPlan.executorRequirements) {
    if (!taskKeys.has(requirement.nodeKey)) {
      invalidState(`Executor requirement references foreign node ${requirement.nodeKey}.`);
    }
    if (requirements.has(requirement.nodeKey)) {
      invalidState(`Executor requirement for node ${requirement.nodeKey} is duplicated.`);
    }
    requirements.set(requirement.nodeKey, requirement);
  }
  return requirements;
};

const indexTerminalBindings = (executionPlan: ExecutionPlan) => {
  const terminals = new Map(
    executionPlan.pipeline.nodes
      .filter((node): node is TerminalNode => node.kind === 'terminal')
      .map((terminal) => [terminal.key, terminal.outcome]),
  );
  const bindings = new Map<NodeKey, string>();
  for (const binding of executionPlan.terminalBindings) {
    if (terminals.get(binding.nodeKey) !== binding.outcome) {
      invalidState(`Terminal binding for node ${binding.nodeKey} is foreign or inconsistent.`);
    }
    if (bindings.has(binding.nodeKey)) {
      invalidState(`Terminal binding for node ${binding.nodeKey} is duplicated.`);
    }
    bindings.set(binding.nodeKey, binding.outcome);
  }
  return bindings;
};

const failedEnvelope = (
  code: Extract<RunErrorCode, 'execution_failed'>,
  message = DEFAULT_EXECUTION_FAILURE_MESSAGE,
): RunTerminalEnvelope => ({
  kind: RUN_TERMINAL_ENVELOPE,
  status: 'failed',
  error: { code, message },
});

export const interpretExecutionPlan = async (
  runId: string,
  executionPlan: ExecutionPlan,
  runInput: JsonValue,
  executor: RunExecutor,
): Promise<RunTerminalEnvelope> => {
  const requirements = indexRequirements(executionPlan);
  const terminalBindings = indexTerminalBindings(executionPlan);
  const nodes = new Map<NodeKey, NodeFact>();
  const verdicts: CandidateVerdict[] = [];
  let executionFailureMessage: string | undefined;
  const facts = (): PipelineFacts => ({
    candidateVerdicts: verdicts,
    gateResolutions: [],
    nodes: [...nodes.values()],
    values: [],
  });
  const enable = (key: NodeKey): void => {
    if (!nodes.has(key)) {
      nodes.set(key, { key, state: 'enabled' });
    }
  };

  while (true) {
    const decision = decidePipeline(executionPlan.pipeline, facts());
    if (decision.kind === 'activate') {
      decision.nodeKeys.forEach(enable);
      continue;
    }
    if (decision.kind === 'select') {
      nodes.set(decision.nodeKey, {
        key: decision.nodeKey,
        outcome: decision.outcome,
        state: 'terminal',
      });
      decision.activate.forEach(enable);
      continue;
    }
    if (decision.kind === 'terminal') {
      const outcome = terminalBindings.get(decision.nodeKey);
      if (outcome === undefined) {
        throw new RunInterpretationError(
          'invalid_workflow_state',
          `Terminal node ${decision.nodeKey} has no binding.`,
        );
      }
      if (outcome !== decision.outcome) {
        invalidState(`Terminal node ${decision.nodeKey} has no matching binding.`);
      }
      if (outcome === 'cancelled') {
        return { kind: RUN_TERMINAL_ENVELOPE, status: 'cancelled' };
      }
      if (outcome === 'failed') {
        return failedEnvelope('execution_failed', executionFailureMessage);
      }
      return {
        kind: RUN_TERMINAL_ENVELOPE,
        status: 'succeeded',
        result: { outcome },
      };
    }
    if (decision.kind !== 'wait') {
      throw new RunInterpretationError(
        'invalid_workflow_state',
        `Pipeline reached ${decision.kind} instead of an executable wait.`,
      );
    }
    const waitingNode = executionPlan.pipeline.nodes.find(({ key }) => key === decision.nodeKey);
    if (waitingNode?.kind === 'task') {
      const readyTasks = executionPlan.pipeline.nodes.filter(
        (node) => node.kind === 'task' && nodes.get(node.key)?.state === 'enabled',
      );
      for (const task of readyTasks) {
        const requirement = requirements.get(task.key);
        const invocation: ExecutionInvocation = {
          executionId: taskExecutionId(runId, task.key),
          runId,
          nodeKey: task.key,
          input: requirement === undefined ? runInput : requirement.input,
          kind: 'task',
          ...(requirement === undefined ? {} : { script: requirement.script }),
        };
        // oxlint-disable-next-line no-await-in-loop -- deterministic effect order is durable workflow state
        const result = await settleExecution(executor, invocation);
        if (result.status === 'failed') {
          executionFailureMessage ??= result.error.message;
          nodes.set(task.key, { key: task.key, outcome: 'failed', state: 'terminal' });
          continue;
        }
        if (result.completion.kind !== 'task') {
          invalidState(`Task ${task.key} returned a candidate completion.`);
        }
        nodes.set(task.key, { key: task.key, outcome: 'completed', state: 'terminal' });
      }
      continue;
    }
    if (waitingNode?.kind === 'consensus') {
      for (const candidateKey of waitingNode.candidates) {
        const invocation: ExecutionInvocation = {
          candidateKey,
          executionId: candidateExecutionId(runId, waitingNode.key, candidateKey),
          input: runInput,
          kind: 'candidate',
          nodeKey: waitingNode.key,
          runId,
        };
        // oxlint-disable-next-line no-await-in-loop -- deterministic effect order is durable workflow state
        const result = await settleExecution(executor, invocation);
        if (result.status === 'failed') {
          throw new RunInterpretationError('execution_failed', result.error.message);
        }
        const completion = result.completion;
        if (completion.kind !== 'candidate') {
          throw new RunInterpretationError(
            'invalid_workflow_state',
            `Candidate ${candidateKey} returned a task completion.`,
          );
        }
        verdicts.push({
          candidate: candidateKey,
          nodeKey: waitingNode.key,
          verdict: completion.verdict,
        });
      }
      continue;
    }
    throw new RunInterpretationError(
      'invalid_workflow_state',
      `Pipeline wait at ${decision.nodeKey} is not executable by this MVP.`,
    );
  }
};
