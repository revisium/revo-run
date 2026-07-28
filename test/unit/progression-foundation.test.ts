import { describe, expect, it } from 'vitest';

import { applyRunProgression, createRun } from '../../src/domain/index.js';
import {
  deriveRunProgressionIdentity,
  snapshotRunExecutionPlanDocument,
  snapshotRunProgressionAppliedReceipt,
  snapshotRunProgressionCommandReceipt,
  snapshotRunProgressionState,
  snapshotRunProgressionValueFacts,
} from '../../src/policy/index.js';
import { nodeFixture, planPin, runFixture } from '../support/store-fixtures.js';

const waitingReceipt = {
  application: 'applied',
  occurrenceKey: 'occurrence-1',
  operation: 'initialize',
  outcome: { kind: 'waiting' },
  schemaVersion: 1,
} as const;

const initializeCommandReceipt = {
  hostAttachment: { kind: 'none' },
  identity: {
    commandKey: 'command-1',
    nodeKey: null,
    operation: 'initialize',
  },
  result: waitingReceipt,
  semanticRequest: {
    kind: 'initialize',
    occurrenceKey: 'occurrence-1',
    values: [{ key: 'input', value: 1 }],
  },
} as const;

const activeState = {
  candidateVerdicts: [],
  commandReceipts: [initializeCommandReceipt],
  gateResolutions: [],
  nodes: [{ nodeKey: 'task', state: 'enabled' }],
  occurrenceKey: 'occurrence-1',
  phase: 'active',
  schemaVersion: 1,
  terminal: null,
  values: [{ key: 'input', source: { kind: 'init' }, value: 1 }],
} as const;

describe('progression foundation', () => {
  it('snapshots exact terminal bindings and rejects duplicate semantic coordinates', () => {
    const input = {
      compiledPipeline: { nodes: ['terminal'] },
      executorBindings: [],
      pin: planPin,
      terminalBindings: [
        {
          fault: {
            code: 'PIPELINE_TERMINAL',
            message: 'The workflow failed.',
          },
          nodeKey: 'terminal',
          outcome: 'failure',
          status: 'failed',
        },
      ],
    } as const;
    const document = snapshotRunExecutionPlanDocument(input);

    expect(document).toEqual(input);
    expect(Object.isFrozen(document.terminalBindings)).toBe(true);
    const binding = document.terminalBindings[0];
    expect(binding?.status).toBe('failed');
    if (binding?.status !== 'failed') throw new TypeError('Expected failed terminal binding.');
    expect(Object.isFrozen(binding.fault)).toBe(true);
    expect(() =>
      snapshotRunExecutionPlanDocument({
        ...input,
        terminalBindings: [input.terminalBindings[0], input.terminalBindings[0]],
      }),
    ).toThrow(TypeError);
  });

  it('enforces NFC 1-64-code-point occurrence keys and exact scalar value facts', () => {
    const facts = snapshotRunProgressionValueFacts([
      { key: 'enabled', value: true },
      { key: 'count', value: 2 },
    ]);

    expect(facts).toEqual([
      { key: 'enabled', value: true },
      { key: 'count', value: 2 },
    ]);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(() => snapshotRunProgressionState({ ...activeState, occurrenceKey: 'e\u0301' })).toThrow(
      TypeError,
    );
    expect(() =>
      snapshotRunProgressionState({ ...activeState, occurrenceKey: 'a'.repeat(65) }),
    ).toThrow(TypeError);
    expect(() =>
      snapshotRunProgressionValueFacts([
        { key: 'duplicate', value: 1 },
        { key: 'duplicate', value: 2 },
      ]),
    ).toThrow(TypeError);

    let reads = 0;
    const accessorFacts: unknown[] = [];
    Object.defineProperty(accessorFacts, '0', {
      enumerable: true,
      get: () => {
        reads += 1;
        return { key: 'unsafe', value: 1 };
      },
    });
    accessorFacts.length = 1;
    expect(() => snapshotRunProgressionValueFacts(accessorFacts)).toThrow(TypeError);
    expect(reads).toBe(0);
    expect(() => snapshotRunProgressionValueFacts(new Array(1))).toThrow(TypeError);
    const customFacts = [{ key: 'custom', value: 1 }];
    Object.defineProperty(customFacts, 'extra', { enumerable: true, value: true });
    expect(() => snapshotRunProgressionValueFacts(customFacts)).toThrow(TypeError);
    expect(() => snapshotRunProgressionValueFacts([{ key: 'unicode', value: '\ud800' }])).toThrow(
      TypeError,
    );

    const emptyEnvelopeBytes = JSON.stringify([{ key: 'large', value: '' }]).length;
    const exactValue = 'a'.repeat(1_048_576 - emptyEnvelopeBytes);
    expect(snapshotRunProgressionValueFacts([{ key: 'large', value: exactValue }])).toHaveLength(1);
    expect(() =>
      snapshotRunProgressionValueFacts([{ key: 'large', value: `${exactValue}a` }]),
    ).toThrow(RangeError);
  });

  it('owns and freezes active state while rejecting duplicate logical nodes', () => {
    const source = {
      ...activeState,
      values: [{ key: 'input', source: { kind: 'init' }, value: 1 }],
    };
    const state = snapshotRunProgressionState(source);

    expect(state).toEqual(source);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.nodes)).toBe(true);
    expect(Object.isFrozen(state.values[0]?.source)).toBe(true);
    expect(() =>
      snapshotRunProgressionState({
        ...source,
        nodes: [source.nodes[0], source.nodes[0]],
      }),
    ).toThrow(TypeError);
  });

  it('keeps applied receipts and command receipts closed, bounded, and immutable', () => {
    const applied = snapshotRunProgressionAppliedReceipt(waitingReceipt);
    const command = snapshotRunProgressionCommandReceipt(initializeCommandReceipt);

    expect(applied).toEqual(waitingReceipt);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.semanticRequest)).toBe(true);
    expect(() => snapshotRunProgressionAppliedReceipt({ ...waitingReceipt, effects: [] })).toThrow(
      TypeError,
    );
    expect(() =>
      snapshotRunProgressionAppliedReceipt({
        ...waitingReceipt,
        outcome: { kind: 'waiting', state: activeState },
      }),
    ).toThrow(TypeError);
    expect(() =>
      snapshotRunProgressionCommandReceipt({
        ...command,
        hostAttachment: { kind: 'none', outputs: [] },
      }),
    ).toThrow(TypeError);
    const cleanup = {
      ...waitingReceipt,
      attemptObservation: {
        attemptId: 'attempt-1',
        fault: null,
        nodeKey: 'retiring',
        status: 'succeeded',
        terminalAt: 2_000,
      },
      operation: 'retired_attempt_observation',
    } as const;
    expect(snapshotRunProgressionAppliedReceipt(cleanup)).toEqual(cleanup);
    expect(() =>
      snapshotRunProgressionAppliedReceipt({
        ...cleanup,
        attemptObservation: { ...cleanup.attemptObservation, attemptId: 'x'.repeat(257) },
      }),
    ).toThrow(RangeError);
    expect(() =>
      snapshotRunProgressionAppliedReceipt({
        ...cleanup,
        attemptObservation: {
          ...cleanup.attemptObservation,
          fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'Unexpected fault.' },
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      snapshotRunProgressionAppliedReceipt({
        ...waitingReceipt,
        operation: 'retired_attempt_observation',
      }),
    ).toThrow(TypeError);
  });

  it.each([
    'INVALID_INPUT',
    'INVALID_STATE',
    'STALE_ACTIVATION',
    'REVISION_CONFLICT',
    'STALE_FENCE',
    'PLAN_UNAVAILABLE',
    'PLAN_MISMATCH',
    'EXECUTOR_UNAVAILABLE',
    'EXECUTOR_MISMATCH',
  ] as const)('accepts normalized cleanup executor failure %s', (code) => {
    const receipt = {
      ...waitingReceipt,
      attemptObservation: {
        attemptId: 'attempt-1',
        fault: { code, message: 'Observed executor failure.' },
        nodeKey: 'retiring',
        status: 'failed',
        terminalAt: 2_000,
      },
      operation: 'retired_attempt_observation',
    } as const;
    expect(snapshotRunProgressionAppliedReceipt(receipt)).toEqual(receipt);
  });

  it.each(['UNKNOWN_OUTCOME', 'CANCELLED'] as const)(
    'rejects non-failure cleanup evidence %s',
    (code) => {
      expect(() =>
        snapshotRunProgressionAppliedReceipt({
          ...waitingReceipt,
          attemptObservation: {
            attemptId: 'attempt-1',
            fault: { code, message: 'Not a known executor failure.' },
            nodeKey: 'retiring',
            status: 'failed',
            terminalAt: 2_000,
          },
          operation: 'retired_attempt_observation',
        }),
      ).toThrow(TypeError);
    },
  );

  it('normalizes every command family with its exact host attachment', () => {
    const result = (
      operation: 'initialize' | 'task_outcome' | 'consensus_verdict' | 'human_gate_resolution',
    ) => ({
      ...waitingReceipt,
      operation,
    });
    const receipts = [
      {
        hostAttachment: {
          kind: 'task_outputs',
          outputs: [{ name: 'result', payload: { kind: 'json', value: { ok: true } } }],
        },
        identity: { commandKey: 'task-1', nodeKey: 'task', operation: 'task_outcome' },
        result: result('task_outcome'),
        semanticRequest: {
          kind: 'task_outcome',
          nodeKey: 'task',
          outcome: { kind: 'succeeded', values: [{ key: 'score', value: 1 }] },
        },
      },
      {
        hostAttachment: { kind: 'none' },
        identity: { commandKey: 'task-2', nodeKey: 'task', operation: 'task_outcome' },
        result: result('task_outcome'),
        semanticRequest: {
          kind: 'task_outcome',
          nodeKey: 'task',
          outcome: { faultCode: 'EXECUTOR_UNAVAILABLE', faultMessage: 'Failed.', kind: 'failed' },
        },
      },
      {
        hostAttachment: { kind: 'none' },
        identity: {
          commandKey: 'consensus-1',
          nodeKey: 'consensus',
          operation: 'consensus_verdict',
        },
        result: result('consensus_verdict'),
        semanticRequest: {
          candidateKey: 'candidate-a',
          kind: 'consensus_verdict',
          nodeKey: 'consensus',
          verdict: 'approve',
        },
      },
      {
        hostAttachment: {
          answerOutput: { kind: 'json', value: { answer: 'yes' } },
          kind: 'gate_answer_output',
        },
        identity: {
          commandKey: 'gate-1',
          nodeKey: 'gate',
          operation: 'human_gate_resolution',
        },
        result: result('human_gate_resolution'),
        semanticRequest: {
          activationId: 'activation-gate',
          kind: 'human_gate_resolution',
          nodeKey: 'gate',
          resolution: 'approved',
          values: [{ key: 'approved', value: true }],
        },
      },
    ] as const;

    for (const receipt of receipts) {
      expect(snapshotRunProgressionCommandReceipt(receipt)).toEqual(receipt);
    }
    expect(() =>
      snapshotRunProgressionCommandReceipt({
        ...receipts[0],
        hostAttachment: { kind: 'none' },
      }),
    ).toThrow(TypeError);
    expect(() =>
      snapshotRunProgressionCommandReceipt({
        ...receipts[2],
        identity: { ...receipts[2].identity, nodeKey: 'other' },
      }),
    ).toThrow(TypeError);
    expect(() =>
      snapshotRunProgressionCommandReceipt({
        ...receipts[0],
        hostAttachment: { ...receipts[0].hostAttachment, answerOutput: { kind: 'json', value: 1 } },
      }),
    ).toThrow(TypeError);
    expect(() =>
      snapshotRunProgressionCommandReceipt({
        ...receipts[3],
        hostAttachment: { ...receipts[3].hostAttachment, outputs: [] },
      }),
    ).toThrow(TypeError);
  });

  it('normalizes terminal applied receipts and complete terminal state', () => {
    const succeeded = snapshotRunProgressionAppliedReceipt({
      ...waitingReceipt,
      operation: 'task_outcome',
      outcome: {
        kind: 'terminal',
        terminal: {
          fault: null,
          nodeKey: 'terminal',
          outcome: 'success',
          status: 'succeeded',
        },
      },
    });
    const failed = snapshotRunProgressionAppliedReceipt({
      ...waitingReceipt,
      operation: 'human_gate_resolution',
      outcome: {
        kind: 'terminal',
        terminal: {
          fault: { code: 'PIPELINE_TERMINAL', message: 'Rejected.' },
          nodeKey: 'terminal',
          outcome: 'rejected',
          status: 'failed',
        },
      },
    });
    const state = snapshotRunProgressionState({
      candidateVerdicts: [
        {
          candidateKey: 'candidate-a',
          nodeKey: 'consensus',
          verdict: 'abstain',
        },
      ],
      commandReceipts: [],
      gateResolutions: [{ nodeKey: 'gate', resolution: 'approved' }],
      nodes: [
        { nodeKey: 'terminal', outcome: 'success', state: 'terminal' },
        {
          nodeKey: 'retired-task',
          state: 'retired',
          terminal: { nodeKey: 'terminal', outcome: 'success' },
        },
      ],
      occurrenceKey: 'occurrence-1',
      phase: 'terminal',
      schemaVersion: 1,
      terminal: { nodeKey: 'terminal', outcome: 'success' },
      values: [
        {
          key: 'answer',
          source: { kind: 'human_gate_resolution', nodeKey: 'gate' },
          value: true,
        },
      ],
    });

    expect(succeeded.outcome.kind).toBe('terminal');
    expect(failed.outcome.kind).toBe('terminal');
    expect(state.phase).toBe('terminal');
    const retired = state.nodes[1];
    if (retired?.state !== 'retired') throw new TypeError('Expected retired progression node.');
    expect(Object.isFrozen(retired.terminal)).toBe(true);
    expect(() =>
      snapshotRunProgressionAppliedReceipt({
        ...waitingReceipt,
        outcome: {
          kind: 'terminal',
          terminal: { fault: null, nodeKey: 'terminal', outcome: 'bad', status: 'failed' },
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      snapshotRunProgressionState({
        ...activeState,
        nodes: [{ nodeKey: 'task', state: 'retired', terminal: state.terminal }],
      }),
    ).toThrow(TypeError);
  });

  it('derives stable semantic identities and validates one applied transition', () => {
    const identityInput = {
      coordinate: 'initialization',
      nodeKey: null,
      occurrenceKey: 'occurrence-1',
      operation: 'initialize',
    } as const;
    const first = deriveRunProgressionIdentity(identityInput);
    const second = deriveRunProgressionIdentity({ ...identityInput });
    const prior = runFixture();
    const node = nodeFixture({
      createdAt: 2_000,
      nodeKey: 'task',
      updatedAt: 2_000,
    });
    const next = createRun({
      ...prior,
      createdAt: 2_000,
      progression: activeState,
      revision: 0,
      updatedAt: 2_000,
    });
    const eventIntent = {
      correlation: {
        activationId: node.activationId,
        kind: 'node',
        nodeInstanceId: node.id,
      },
      kind: 'node.activated',
      payload: {
        activationKey: node.activationKey,
        branchKey: null,
        forkScopeKey: node.forkScopeKey,
        iteration: 0,
        nodeKey: 'task',
        status: 'ready',
      },
      runId: prior.id,
    } as const;
    const expected = {
      attempts: [],
      changed: true,
      eventIntents: [eventIntent],
      nodes: [node],
      outputs: [],
      run: next,
    } as const;
    const activationStep = {
      cause: { kind: 'entry' },
      kind: 'activate_node',
      node,
      nodeKey: 'task',
      nodeKind: 'task',
    } as const;

    expect(first).toEqual(second);
    expect(first.commandKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      applyRunProgression({
        intent: {
          nextState: activeState,
          receipt: waitingReceipt,
          steps: [{ kind: 'initialize' }, activationStep],
        },
        projection: { attempts: [], nodes: [], outputs: [], run: prior },
        transactionNow: 2_000,
      }),
    ).toEqual(expected);
    expect(() =>
      applyRunProgression({
        intent: { nextState: activeState, receipt: waitingReceipt, steps: [] },
        projection: { attempts: [], nodes: [], outputs: [], run: prior },
        transactionNow: 2_001,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: activeState,
          receipt: waitingReceipt,
          steps: [{ kind: 'initialize' }, { kind: 'initialize' }],
        },
        projection: { attempts: [], nodes: [], outputs: [], run: prior },
        transactionNow: 2_000,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: activeState,
          receipt: waitingReceipt,
          steps: [activationStep, { kind: 'initialize' }],
        },
        projection: { attempts: [], nodes: [], outputs: [], run: prior },
        transactionNow: 2_000,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: activeState,
          receipt: waitingReceipt,
          steps: [{ kind: 'initialize' }, activationStep, activationStep],
        },
        projection: { attempts: [], nodes: [], outputs: [], run: prior },
        transactionNow: 2_000,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: activeState,
          receipt: { ...waitingReceipt, occurrenceKey: 'other-occurrence' },
          steps: [{ kind: 'initialize' }, activationStep],
        },
        projection: { attempts: [], nodes: [], outputs: [], run: prior },
        transactionNow: 2_000,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: activeState,
          receipt: waitingReceipt,
          steps: [{ kind: 'initialize' }, activationStep],
        },
        projection: { attempts: [], nodes: [], outputs: [], run: prior },
        transactionNow: -1,
      }),
    ).toThrow(TypeError);
  });
});
