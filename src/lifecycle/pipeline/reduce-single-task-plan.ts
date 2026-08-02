import {
  decodeCompiledPipeline,
  reducePipeline,
  type CompiledPipeline,
  type PipelineCommand,
  type PipelineEffect,
  type PipelineSnapshot,
} from '@revisium/revo-pipeline';

import {
  createAttempt,
  createRunNodeInstance,
  createRunOutput,
  deriveActivationKey,
  deriveRootForkScopeKey,
  type RunProgressionIntent,
  type RunProgressionProjection,
} from '../../domain/index.js';
import { digestCanonicalJson } from '../../policy/index.js';
import type { RunExecutionPlanDocument, RunOutputPayload } from '../../spec/index.js';
import type { LifecycleProgressionObservation } from '../lifecycle-progression-observation.js';

interface Allocation {
  readonly activationId: string;
  readonly nodeInstanceId: string;
}

const planFault = (
  code: 'PLAN_INVALID' | 'PLAN_UNSUPPORTED' | 'PROGRESSION_STATE_INVALID',
): never => {
  throw new TypeError(code);
};

const decodeSupportedPlan = (document: RunExecutionPlanDocument): CompiledPipeline => {
  const decoded = decodeCompiledPipeline(document.compiledPipeline);
  if (!decoded.ok) return planFault('PLAN_INVALID');
  const tasks = decoded.pipeline.nodes.filter((node) => node.kind === 'task');
  const terminals = decoded.pipeline.nodes.filter((node) => node.kind === 'terminal');
  if (
    decoded.pipeline.nodes.length !== 2 ||
    tasks.length !== 1 ||
    terminals.length !== 1 ||
    decoded.pipeline.entry !== tasks[0]?.key ||
    decoded.pipeline.facts.length !== 0 ||
    decoded.pipeline.forkRegions.length !== 0
  ) {
    return planFault('PLAN_UNSUPPORTED');
  }
  const task = tasks[0];
  const terminal = terminals[0];
  if (
    task === undefined ||
    terminal === undefined ||
    Object.values(task.outcomes).some((target) => target !== terminal.key) ||
    document.executorBindings.length !== 1 ||
    document.executorBindings[0]?.nodeKey !== task.key ||
    document.terminalBindings.length !== 1 ||
    document.terminalBindings[0]?.nodeKey !== terminal.key ||
    document.terminalBindings[0]?.outcome !== terminal.outcome
  ) {
    return planFault('PLAN_UNSUPPORTED');
  }
  return decoded.pipeline;
};

const projectSnapshot = (projection: RunProgressionProjection): PipelineSnapshot => {
  const state = projection.run.progression;
  if (
    state.values.length !== 0 ||
    state.candidateVerdicts.length !== 0 ||
    state.gateResolutions.length !== 0
  ) {
    return planFault('PLAN_UNSUPPORTED');
  }
  if (state.phase === 'uninitialized') {
    return {
      schemaVersion: 1,
      occurrenceKey: state.occurrenceKey,
      phase: 'uninitialized',
      values: [],
      nodes: [],
      candidateVerdicts: [],
      gateResolutions: [],
      terminal: null,
    };
  }
  const nodes = state.nodes.map((node) =>
    node.state === 'enabled'
      ? {
          occurrence: { occurrenceKey: state.occurrenceKey, nodeKey: node.nodeKey },
          state: 'enabled' as const,
        }
      : node.state === 'terminal'
        ? {
            occurrence: { occurrenceKey: state.occurrenceKey, nodeKey: node.nodeKey },
            outcome: node.outcome,
            state: 'terminal' as const,
          }
        : {
            occurrence: { occurrenceKey: state.occurrenceKey, nodeKey: node.nodeKey },
            state: 'retired' as const,
            terminal: {
              occurrence: {
                occurrenceKey: state.occurrenceKey,
                nodeKey: node.terminal.nodeKey,
              },
              outcome: node.terminal.outcome,
            },
          },
  );
  if (state.phase === 'active') {
    const activeNodes = nodes.filter((node) => node.state !== 'retired');
    if (activeNodes.length !== nodes.length) return planFault('PLAN_INVALID');
    return {
      schemaVersion: 1,
      occurrenceKey: state.occurrenceKey,
      phase: 'active',
      values: [],
      nodes: activeNodes,
      candidateVerdicts: [],
      gateResolutions: [],
      terminal: null,
    };
  }
  return {
    schemaVersion: 1,
    occurrenceKey: state.occurrenceKey,
    phase: 'terminal',
    values: [],
    nodes,
    candidateVerdicts: [],
    gateResolutions: [],
    terminal: {
      occurrence: { occurrenceKey: state.occurrenceKey, nodeKey: state.terminal.nodeKey },
      outcome: state.terminal.outcome,
    },
  };
};

const reduceOnce = (
  document: RunExecutionPlanDocument,
  snapshot: PipelineSnapshot,
  command: PipelineCommand,
) => {
  const reduced = reducePipeline(decodeSupportedPlan(document), snapshot, command);
  if (!reduced.ok) return planFault('PLAN_INVALID');
  return reduced;
};

const requireEffects = (
  effects: readonly PipelineEffect[],
  kinds: readonly PipelineEffect['kind'][],
): void => {
  if (
    effects.length !== kinds.length ||
    effects.some((effect, index) => effect.kind !== kinds[index])
  ) {
    planFault('PLAN_UNSUPPORTED');
  }
};

const terminalPolicy = (document: RunExecutionPlanDocument, nodeKey: string, outcome: string) => {
  const matches = document.terminalBindings.filter(
    (binding) => binding.nodeKey === nodeKey && binding.outcome === outcome,
  );
  if (matches.length !== 1 || matches[0] === undefined) return planFault('PLAN_INVALID');
  return matches[0];
};

const nextState = (
  projection: RunProgressionProjection,
  snapshot: PipelineSnapshot,
  commandReceipt: RunProgressionProjection['run']['progression']['commandReceipts'][number],
): RunProgressionIntent['nextState'] => {
  if (snapshot.phase === 'uninitialized') return planFault('PLAN_INVALID');
  const nodes = snapshot.nodes.map((node) =>
    node.state === 'retired'
      ? {
          nodeKey: node.occurrence.nodeKey,
          state: node.state,
          terminal: {
            nodeKey: node.terminal.occurrence.nodeKey,
            outcome: node.terminal.outcome,
          },
        }
      : node.state === 'terminal'
        ? { nodeKey: node.occurrence.nodeKey, state: node.state, outcome: node.outcome }
        : { nodeKey: node.occurrence.nodeKey, state: node.state },
  );
  const common = {
    schemaVersion: 1 as const,
    occurrenceKey: snapshot.occurrenceKey,
    values: [],
    candidateVerdicts: [],
    gateResolutions: [],
    commandReceipts: [...projection.run.progression.commandReceipts, commandReceipt],
  };
  if (snapshot.phase === 'active') {
    const activeNodes = nodes.filter(
      (node): node is Extract<(typeof nodes)[number], { readonly state: 'enabled' | 'terminal' }> =>
        node.state !== 'retired',
    );
    if (activeNodes.length !== nodes.length) return planFault('PLAN_INVALID');
    return { ...common, nodes: activeNodes, phase: 'active', terminal: null };
  }
  const terminalNodes = nodes.filter(
    (node): node is Extract<(typeof nodes)[number], { readonly state: 'retired' | 'terminal' }> =>
      node.state !== 'enabled',
  );
  if (terminalNodes.length !== nodes.length) return planFault('PLAN_INVALID');
  return {
    ...common,
    nodes: terminalNodes,
    phase: 'terminal',
    terminal: {
      nodeKey: snapshot.terminal.occurrence.nodeKey,
      outcome: snapshot.terminal.outcome,
    },
  };
};

const reduceSingleTaskInitialization = (input: {
  readonly document: RunExecutionPlanDocument;
  readonly projection: RunProgressionProjection;
  readonly occurrenceKey: string;
  readonly allocation: Allocation;
  readonly transactionNow: number;
}): RunProgressionIntent => {
  const reduced = reduceOnce(input.document, projectSnapshot(input.projection), {
    schemaVersion: 1,
    kind: 'init',
    values: [],
  });
  if (reduced.status !== 'waiting' || reduced.wait.reason !== 'task-incomplete') {
    return planFault('PLAN_UNSUPPORTED');
  }
  requireEffects(reduced.batch.items, ['initialize', 'activateNode']);
  const activation = reduced.batch.items[1];
  if (
    activation?.kind !== 'activateNode' ||
    activation.occurrence.nodeKey !== reduced.wait.occurrence.nodeKey
  ) {
    return planFault('PLAN_INVALID');
  }
  const forkScopeKey = deriveRootForkScopeKey(input.projection.run.id);
  const node = createRunNodeInstance({
    activationContext: null,
    activationId: input.allocation.activationId,
    activationKey: deriveActivationKey({
      branchKey: null,
      forkScopeKey,
      iteration: 0,
      nodeKey: activation.occurrence.nodeKey,
    }),
    activeAttemptId: null,
    branchKey: null,
    createdAt: input.transactionNow,
    forkScopeKey,
    id: input.allocation.nodeInstanceId,
    iteration: 0,
    nodeKey: activation.occurrence.nodeKey,
    parentActivationId: null,
    retryAvailableAt: null,
    revision: 0,
    runId: input.projection.run.id,
    status: 'ready',
    terminalAt: null,
    terminalFault: null,
    updatedAt: input.transactionNow,
  });
  const receipt = {
    application: 'applied' as const,
    occurrenceKey: input.occurrenceKey,
    operation: 'initialize' as const,
    outcome: { kind: 'waiting' as const },
    schemaVersion: 1 as const,
  };
  return {
    nextState: nextState(input.projection, reduced.snapshot, {
      hostAttachment: { kind: 'none' },
      identity: { commandKey: 'initialize', nodeKey: null, operation: 'initialize' },
      result: receipt,
      semanticRequest: { kind: 'initialize', occurrenceKey: input.occurrenceKey, values: [] },
    }),
    receipt,
    steps: [
      { kind: 'initialize' },
      {
        cause: { kind: 'entry' },
        kind: 'activate_node',
        node,
        nodeKey: node.nodeKey,
        nodeKind: 'task',
      },
    ],
  };
};

const outcomeCommand = (observation: LifecycleProgressionObservation) =>
  observation.kind === 'succeeded' ? 'completed' : observation.kind;

const terminalFault = (observation: LifecycleProgressionObservation) =>
  observation.kind === 'failed' ? observation.fault : null;

const outputPayload = (payload: RunOutputPayload): RunOutputPayload => payload;

const reduceSingleTaskOutcome = (input: {
  readonly document: RunExecutionPlanDocument;
  readonly projection: RunProgressionProjection;
  readonly observation: LifecycleProgressionObservation;
  readonly transactionNow: number;
  readonly allocation: Allocation;
}): RunProgressionIntent => {
  const node = input.projection.nodes[0];
  const attempt = input.projection.attempts[0];
  if (node === undefined || attempt === undefined || node.activeAttemptId !== attempt.id) {
    return planFault('PROGRESSION_STATE_INVALID');
  }
  const reduced = reduceOnce(input.document, projectSnapshot(input.projection), {
    schemaVersion: 1,
    kind: 'taskOutcome',
    occurrence: {
      occurrenceKey: input.projection.run.progression.occurrenceKey,
      nodeKey: node.nodeKey,
    },
    outcome: outcomeCommand(input.observation),
    values: [],
  });
  if (reduced.status !== 'terminal') return planFault('PLAN_UNSUPPORTED');
  requireEffects(reduced.batch.items, ['completeTask', 'activateNode', 'terminatePipeline']);
  const completed = reduced.batch.items[0];
  const terminalActivation = reduced.batch.items[1];
  if (completed?.kind !== 'completeTask') return planFault('PLAN_INVALID');
  if (
    terminalActivation?.kind !== 'activateNode' ||
    terminalActivation.occurrence.nodeKey !== reduced.terminal.occurrence.nodeKey ||
    terminalActivation.cause.kind !== 'node' ||
    terminalActivation.cause.nodeKey !== node.nodeKey
  ) {
    return planFault('PLAN_INVALID');
  }
  const policy = terminalPolicy(
    input.document,
    reduced.terminal.occurrence.nodeKey,
    reduced.terminal.outcome,
  );
  const terminal =
    policy.status === 'failed'
      ? {
          nodeKey: reduced.terminal.occurrence.nodeKey,
          outcome: reduced.terminal.outcome,
          status: 'failed' as const,
          fault: policy.fault,
        }
      : {
          nodeKey: reduced.terminal.occurrence.nodeKey,
          outcome: reduced.terminal.outcome,
          status: policy.status,
          fault: null,
        };
  const receipt = {
    application: 'applied' as const,
    occurrenceKey: input.projection.run.progression.occurrenceKey,
    operation: 'task_outcome' as const,
    outcome: {
      kind: 'terminal' as const,
      terminal,
    },
    schemaVersion: 1 as const,
  };
  const status = input.observation.kind === 'succeeded' ? 'succeeded' : input.observation.kind;
  const nextAttempt = createAttempt({
    ...attempt,
    fault: terminalFault(input.observation),
    progressionClosedAt: input.transactionNow,
    revision: attempt.revision + 1,
    status,
    terminalAt: input.transactionNow,
    updatedAt: input.transactionNow,
  });
  const nextNode = createRunNodeInstance({
    ...node,
    activeAttemptId: null,
    revision: node.revision + 1,
    status,
    terminalAt: input.transactionNow,
    terminalFault: terminalFault(input.observation),
    updatedAt: input.transactionNow,
  });
  const outputs =
    input.observation.kind === 'succeeded'
      ? input.observation.outputs.map((output) =>
          createRunOutput({
            correlation: {
              activationId: node.activationId,
              attemptId: attempt.id,
              kind: 'attempt',
              nodeInstanceId: node.id,
            },
            createdAt: input.transactionNow,
            id: output.outputId,
            name: output.name,
            payload: outputPayload(output.payload),
            runId: input.projection.run.id,
          }),
        )
      : [];
  const terminalNode = createRunNodeInstance({
    activationContext: null,
    activationId: input.allocation.activationId,
    activationKey: deriveActivationKey({
      branchKey: node.branchKey,
      forkScopeKey: node.forkScopeKey,
      iteration: 0,
      nodeKey: terminalActivation.occurrence.nodeKey,
    }),
    activeAttemptId: null,
    branchKey: node.branchKey,
    createdAt: input.transactionNow,
    forkScopeKey: node.forkScopeKey,
    id: input.allocation.nodeInstanceId,
    iteration: 0,
    nodeKey: terminalActivation.occurrence.nodeKey,
    parentActivationId: node.activationId,
    retryAvailableAt: null,
    revision: 0,
    runId: input.projection.run.id,
    status: 'succeeded',
    terminalAt: input.transactionNow,
    terminalFault: null,
    updatedAt: input.transactionNow,
  });
  return {
    nextState: nextState(input.projection, reduced.snapshot, {
      hostAttachment:
        input.observation.kind === 'succeeded'
          ? {
              kind: 'task_outputs',
              outputs: input.observation.outputs.map(({ name, payload }) => ({ name, payload })),
            }
          : { kind: 'none' },
      identity: {
        commandKey: `task:${attempt.id}`,
        nodeKey: node.nodeKey,
        operation: 'task_outcome',
      },
      result: receipt,
      semanticRequest: {
        kind: 'task_outcome',
        nodeKey: node.nodeKey,
        outcome:
          input.observation.kind === 'succeeded'
            ? { kind: 'succeeded', values: [] }
            : input.observation.kind === 'failed'
              ? {
                  kind: 'failed',
                  faultCode: input.observation.fault.code,
                  faultMessage: input.observation.fault.message,
                }
              : { kind: 'cancelled' },
      },
    }),
    receipt,
    steps: [
      {
        attempt: nextAttempt,
        kind: 'complete_task',
        node: nextNode,
        nodeKey: node.nodeKey,
        outcome: completed.outcome,
        outputs,
      },
      {
        cause: {
          kind: 'successor',
          predecessorActivationId: node.activationId,
          predecessorNodeKey: node.nodeKey,
        },
        kind: 'activate_node',
        node: terminalNode,
        nodeKey: terminalNode.nodeKey,
        nodeKind: 'terminal',
      },
      {
        kind: 'terminate',
        nodeKey: reduced.terminal.occurrence.nodeKey,
        outcome: reduced.terminal.outcome,
        retirements: [],
      },
    ],
  };
};

const deriveSingleTaskAllocation = (seed: string): Allocation => ({
  activationId: digestCanonicalJson(['revo-run', 'activation', 'v1', seed, 0]),
  nodeInstanceId: digestCanonicalJson(['revo-run', 'node-instance', 'v1', seed, 0]),
});

export const singleTaskPlanReducer = Object.freeze({
  deriveAllocation: deriveSingleTaskAllocation,
  reduceInitialization: reduceSingleTaskInitialization,
  reduceOutcome: reduceSingleTaskOutcome,
});
