import {
  applyRunProgression,
  createAttempt,
  createRun,
  createRunNodeInstance,
} from '../../src/domain/index.js';
import type {
  RunProgressionAppliedReceipt,
  RunProgressionCommandReceipt,
} from '../../src/domain/index.js';
import type {
  RunStoreProgressionTransitionCommand,
  RunStoreProgressionTrigger,
} from '../../src/storage/index.js';
import {
  attemptExpectation,
  attemptFixture,
  configurationDigest,
  executorPin,
  nodeExpectation,
  nodeFixture,
  runExpectation,
  runFixture,
} from './store-fixtures.js';

export const progressionTransactionNow = 2_000;

export const progressionAppliedReceipt = (
  operation: Exclude<RunProgressionAppliedReceipt['operation'], 'retired_attempt_observation'>,
): RunProgressionAppliedReceipt => ({
  application: 'applied',
  occurrenceKey: 'occurrence-1',
  operation,
  outcome: { kind: 'waiting' },
  schemaVersion: 1,
});

export const progressionCommandReceipt = (
  operation: Exclude<RunProgressionAppliedReceipt['operation'], 'retired_attempt_observation'>,
): RunProgressionCommandReceipt => {
  const result = progressionAppliedReceipt(operation);
  if (operation === 'initialize') {
    return {
      hostAttachment: { kind: 'none' },
      identity: { commandKey: 'initialize-command', nodeKey: null, operation },
      result,
      semanticRequest: { kind: 'initialize', occurrenceKey: 'occurrence-1', values: [] },
    };
  }
  if (operation === 'task_outcome') {
    return {
      hostAttachment: { kind: 'task_outputs', outputs: [] },
      identity: { commandKey: 'task-command', nodeKey: 'task', operation },
      result,
      semanticRequest: {
        kind: 'task_outcome',
        nodeKey: 'task',
        outcome: { kind: 'succeeded', values: [] },
      },
    };
  }
  if (operation === 'consensus_verdict') {
    return {
      hostAttachment: { kind: 'none' },
      identity: { commandKey: 'verdict-command', nodeKey: 'selector', operation },
      result,
      semanticRequest: {
        candidateKey: 'candidate-a',
        kind: 'consensus_verdict',
        nodeKey: 'selector',
        verdict: 'approve',
      },
    };
  }
  return {
    hostAttachment: { answerOutput: { kind: 'json', value: 'yes' }, kind: 'gate_answer_output' },
    identity: { commandKey: 'gate-command', nodeKey: 'gate', operation },
    result,
    semanticRequest: {
      activationId: 'activation-1',
      kind: 'human_gate_resolution',
      nodeKey: 'gate',
      resolution: 'approved',
      values: [],
    },
  };
};

export const progressionActiveRun = (
  receipts: readonly RunProgressionCommandReceipt[] = [progressionCommandReceipt('initialize')],
) =>
  runFixture({
    progression: {
      candidateVerdicts: [],
      commandReceipts: receipts,
      gateResolutions: [],
      nodes: [],
      occurrenceKey: 'occurrence-1',
      phase: 'active',
      schemaVersion: 1,
      terminal: null,
      values: [],
    },
  });

export const progressionOperationCase = (
  operation: 'task_outcome' | 'consensus_verdict' | 'human_gate_resolution',
) => {
  const run = progressionActiveRun();
  const incumbent = operation === 'task_outcome';
  const node = nodeFixture({
    activationId:
      operation === 'human_gate_resolution' ? 'activation-1' : `${operation}-activation`,
    activeAttemptId: incumbent ? 'attempt-1' : null,
    id: `${operation}-node`,
    nodeKey: operation === 'human_gate_resolution' ? 'gate' : incumbent ? 'task' : 'selector',
    status: incumbent
      ? 'executing'
      : operation === 'human_gate_resolution'
        ? 'gate_waiting'
        : 'selector_waiting',
  });
  const attempts = incumbent ? [attemptFixture({ nodeInstanceId: node.id })] : [];
  const receipt = progressionCommandReceipt(operation);
  const nextRun = createRun({
    ...run,
    progression: {
      ...run.progression,
      commandReceipts: [...run.progression.commandReceipts, receipt],
    },
    revision: 1,
    updatedAt: progressionTransactionNow,
  });
  const trigger: RunStoreProgressionTrigger = incumbent
    ? {
        authority: {
          attemptId: 'attempt-1',
          executorConfigurationDigest: configurationDigest,
          executorContractPin: executorPin,
          expectedAttemptRevision: 0,
          expectedNodeRevision: 0,
          expectedRunRevision: 0,
          fencingToken: 1,
          managerIncarnationId: 'manager-1',
        },
        kind: 'incumbent_attempt',
      }
    : {
        activationId: node.activationId,
        kind: 'activation',
        nodeInstanceId: node.id,
        runId: run.id,
      };
  const command: RunStoreProgressionTransitionCommand = {
    expected: {
      kind: 'transition',
      value: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: incumbent ? [attemptExpectation(attempts[0]!)] : [],
        nodes: [nodeExpectation(node)],
        run: runExpectation(run),
      },
    },
    idempotency: {
      identity: {
        key: `${operation}-external`,
        operation:
          operation === 'task_outcome'
            ? 'task_outcome_progression'
            : operation === 'consensus_verdict'
              ? 'consensus_verdict_progression'
              : 'human_gate_resolution_progression',
        runId: run.id,
        subjectId:
          trigger.kind === 'incumbent_attempt' ? trigger.authority.attemptId : trigger.activationId,
      },
      request: operation === 'human_gate_resolution' ? { answer: 'yes', operation } : { operation },
      result: receipt.result,
    },
    kind: 'apply_progression_transition',
    operation,
    transition: {
      attempts,
      changed: true,
      eventIntents: [],
      nodes: [node],
      outputs: [],
      run: nextRun,
    },
    trigger,
  };
  return { attempts, command, nodes: [node], run };
};

export const progressionTerminalTaskCase = () => {
  const priorState = {
    candidateVerdicts: [],
    commandReceipts: [progressionCommandReceipt('initialize')],
    gateResolutions: [],
    nodes: [{ nodeKey: 'task', state: 'enabled' }],
    occurrenceKey: 'occurrence-1',
    phase: 'active',
    schemaVersion: 1,
    terminal: null,
    values: [],
  } as const;
  const run = createRun({ ...runFixture(), progression: priorState });
  const attempt = attemptFixture({ status: 'start_committed' });
  const node = nodeFixture({
    activeAttemptId: attempt.id,
    nodeKey: 'task',
    status: 'executing',
  });
  const nextAttempt = createAttempt({
    ...attempt,
    revision: 1,
    status: 'succeeded',
    terminalAt: progressionTransactionNow,
    updatedAt: progressionTransactionNow,
  });
  const nextNode = createRunNodeInstance({
    ...node,
    activeAttemptId: null,
    revision: 1,
    status: 'succeeded',
    terminalAt: progressionTransactionNow,
    updatedAt: progressionTransactionNow,
  });
  const baseReceipt = progressionCommandReceipt('task_outcome');
  const terminal = { nodeKey: 'task', outcome: 'done' } as const;
  const result = {
    ...baseReceipt.result,
    outcome: {
      kind: 'terminal',
      terminal: { fault: null, nodeKey: 'task', outcome: 'done', status: 'succeeded' },
    },
  } as const;
  const durableReceipt = { ...baseReceipt, result };
  const nextState = {
    ...priorState,
    commandReceipts: [...priorState.commandReceipts, durableReceipt],
    nodes: [{ nodeKey: 'task', outcome: 'done', state: 'terminal' }],
    phase: 'terminal',
    terminal,
  } as const;
  const transition = applyRunProgression({
    intent: {
      nextState,
      receipt: result,
      steps: [
        {
          attempt: nextAttempt,
          kind: 'complete_task',
          node: nextNode,
          nodeKey: 'task',
          outcome: 'done',
          outputs: [],
        },
        {
          kind: 'terminate',
          nodeKey: 'task',
          outcome: 'done',
          retirements: [],
        },
      ],
    },
    projection: { attempts: [attempt], nodes: [node], outputs: [], run },
    transactionNow: progressionTransactionNow,
  });
  const command: RunStoreProgressionTransitionCommand = {
    expected: {
      kind: 'transition',
      value: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: [attemptExpectation(attempt)],
        nodes: [nodeExpectation(node)],
        run: runExpectation(run),
      },
    },
    idempotency: {
      identity: {
        key: 'terminal-task-external',
        operation: 'task_outcome_progression',
        runId: run.id,
        subjectId: attempt.id,
      },
      request: { operation: 'task_outcome' },
      result,
    },
    kind: 'apply_progression_transition',
    operation: 'task_outcome',
    transition,
    trigger: {
      authority: {
        attemptId: attempt.id,
        executorConfigurationDigest: configurationDigest,
        executorContractPin: executorPin,
        expectedAttemptRevision: attempt.revision,
        expectedNodeRevision: node.revision,
        expectedRunRevision: run.revision,
        fencingToken: attempt.fencingToken,
        managerIncarnationId: attempt.managerIncarnationId,
      },
      kind: 'incumbent_attempt',
    },
  };
  return { attempt, command, node, run };
};

export const progressionCleanupCase = () => {
  const terminal = { nodeKey: 'terminal', outcome: 'done' } as const;
  const terminalTask = progressionCommandReceipt('task_outcome');
  const terminalResult = {
    ...terminalTask.result,
    outcome: {
      kind: 'terminal',
      terminal: { fault: null, nodeKey: 'terminal', outcome: 'done', status: 'succeeded' },
    },
  } as const;
  const terminalTaskReceipt = { ...terminalTask, result: terminalResult };
  const state = {
    candidateVerdicts: [],
    commandReceipts: [progressionCommandReceipt('initialize'), terminalTaskReceipt],
    gateResolutions: [],
    nodes: [
      { nodeKey: 'terminal', outcome: 'done', state: 'terminal' },
      { nodeKey: 'retiring', state: 'retired', terminal },
    ],
    occurrenceKey: 'occurrence-1',
    phase: 'terminal',
    schemaVersion: 1,
    terminal,
    values: [],
  } as const;
  const run = createRun({
    ...runFixture(),
    progression: state,
    status: 'succeeded',
    terminalAt: 1_500,
    updatedAt: 1_500,
  });
  const attempt = attemptFixture({
    nodeInstanceId: 'retiring-node',
    progressionClosedAt: 1_500,
    status: 'start_committed',
    updatedAt: 1_500,
  });
  const node = nodeFixture({
    activationId: 'retiring-activation',
    activeAttemptId: attempt.id,
    id: 'retiring-node',
    nodeKey: 'retiring',
    status: 'retiring',
    updatedAt: 1_500,
  });
  const selected = nodeFixture({
    activeAttemptId: null,
    id: 'terminal-node',
    nodeKey: 'terminal',
    status: 'succeeded',
    terminalAt: 1_500,
    updatedAt: 1_500,
  });
  const nextAttempt = createAttempt({
    ...attempt,
    revision: 1,
    status: 'succeeded',
    terminalAt: progressionTransactionNow,
    updatedAt: progressionTransactionNow,
  });
  const nextNode = createRunNodeInstance({
    ...node,
    activeAttemptId: null,
    revision: 1,
    status: 'retired',
    terminalAt: progressionTransactionNow,
    updatedAt: progressionTransactionNow,
  });
  const receipt = {
    application: 'applied',
    attemptObservation: {
      attemptId: nextAttempt.id,
      fault: null,
      nodeKey: node.nodeKey,
      status: 'succeeded',
      terminalAt: nextAttempt.terminalAt!,
    },
    occurrenceKey: 'occurrence-1',
    operation: 'retired_attempt_observation',
    outcome: { kind: 'terminal', terminal: terminalResult.outcome.terminal },
    schemaVersion: 1,
  } as const;
  const transition = applyRunProgression({
    intent: {
      nextState: state,
      receipt,
      steps: [
        {
          attempt: nextAttempt,
          attemptId: attempt.id,
          kind: 'settle_retired_attempt',
          node: nextNode,
          nodeKey: node.nodeKey,
        },
      ],
    },
    projection: { attempts: [attempt], nodes: [selected, node], outputs: [], run },
    transactionNow: progressionTransactionNow,
  });
  const command: RunStoreProgressionTransitionCommand = {
    expected: {
      kind: 'transition',
      value: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: [attemptExpectation(attempt)],
        nodes: [nodeExpectation(node)],
        run: runExpectation(run),
      },
    },
    idempotency: {
      identity: {
        key: 'cleanup-external',
        operation: 'retired_attempt_observation',
        runId: run.id,
        subjectId: attempt.id,
      },
      request: { attemptId: attempt.id, operation: 'retired_attempt_observation' },
      result: receipt,
    },
    kind: 'apply_progression_transition',
    operation: 'retired_attempt_observation',
    transition,
    trigger: {
      authority: {
        attemptId: attempt.id,
        executorConfigurationDigest: configurationDigest,
        executorContractPin: executorPin,
        expectedAttemptRevision: 0,
        expectedNodeRevision: 0,
        expectedRunRevision: 0,
        fencingToken: 1,
        managerIncarnationId: 'manager-1',
      },
      kind: 'incumbent_attempt',
    },
  };
  return { attempt, command, node, nodes: [selected, node], run };
};
