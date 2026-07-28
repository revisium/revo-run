import { describe, expect, it } from 'vitest';

import {
  applyRunProgression,
  createAttempt,
  createRun,
  createRunNodeInstance,
  deriveChildForkScopeKey,
} from '../../src/domain/index.js';
import type { RunProgressionIntentStep } from '../../src/domain/index.js';
import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import {
  progressionCommandReceipt,
  progressionTransactionNow,
} from '../support/progression-store-fixtures.js';
import {
  attemptFixture,
  nodeFixture,
  outputFixture,
  runFixture,
} from '../support/store-fixtures.js';

const initializeReceipt = progressionCommandReceipt('initialize');

const activeRun = (nodeKey: string) => {
  const state = {
    candidateVerdicts: [],
    commandReceipts: [initializeReceipt],
    gateResolutions: [],
    nodes: [{ nodeKey, state: 'enabled' }],
    occurrenceKey: 'occurrence-1',
    phase: 'active',
    schemaVersion: 1,
    terminal: null,
    values: [],
  } as const;
  return { run: createRun({ ...runFixture(), progression: state }), state };
};

describe('Run progression application', () => {
  it.each([
    ['unknown', 'succeeded'],
    ['unknown', 'failed'],
    ['unknown', 'cancelled'],
    ['reconciling', 'succeeded'],
    ['reconciling', 'failed'],
    ['reconciling', 'cancelled'],
  ] as const)('settles exact %s cleanup observation to %s', (priorStatus, nextStatus) => {
    const terminal = { nodeKey: 'terminal', outcome: 'done' } as const;
    const state = {
      candidateVerdicts: [],
      commandReceipts: [initializeReceipt],
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
    const selected = nodeFixture({
      nodeKey: 'terminal',
      status: 'succeeded',
      terminalAt: 1_500,
      updatedAt: 1_500,
    });
    const priorAttempt = attemptFixture({
      nodeInstanceId: 'retiring-node',
      progressionClosedAt: 1_500,
      status: priorStatus,
      updatedAt: 1_500,
    });
    const priorNode = nodeFixture({
      activeAttemptId: priorAttempt.id,
      id: 'retiring-node',
      nodeKey: 'retiring',
      status: 'retiring',
      updatedAt: 1_500,
    });
    const fault =
      nextStatus === 'failed'
        ? { code: 'EXECUTOR_UNAVAILABLE' as const, message: 'Observed cleanup failure.' }
        : null;
    const nextAttempt = createAttempt({
      ...priorAttempt,
      fault,
      revision: 1,
      status: nextStatus,
      terminalAt: progressionTransactionNow,
      updatedAt: progressionTransactionNow,
    });
    const nextNode = createRunNodeInstance({
      ...priorNode,
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
        fault,
        nodeKey: 'retiring',
        status: nextStatus,
        terminalAt: progressionTransactionNow,
      },
      occurrenceKey: 'occurrence-1',
      operation: 'retired_attempt_observation',
      outcome: {
        kind: 'terminal',
        terminal: { fault: null, nodeKey: 'terminal', outcome: 'done', status: 'succeeded' },
      },
      schemaVersion: 1,
    } as const;

    expect(
      applyRunProgression({
        intent: {
          nextState: state,
          receipt,
          steps: [
            {
              attempt: nextAttempt,
              attemptId: priorAttempt.id,
              kind: 'settle_retired_attempt',
              node: nextNode,
              nodeKey: 'retiring',
            },
          ],
        },
        projection: {
          attempts: [priorAttempt],
          nodes: [selected, priorNode],
          outputs: [],
          run,
        },
        transactionNow: progressionTransactionNow,
      }),
    ).toMatchObject({ eventIntents: [], run });
  });

  it('folds and commits an empty producer-shaped initialization batch', async () => {
    const run = runFixture();
    const fork = nodeFixture({
      activationId: 'fold-fork',
      createdAt: progressionTransactionNow,
      id: 'fold-fork-node',
      nodeKey: 'fork',
      status: 'selector_waiting',
      updatedAt: progressionTransactionNow,
    });
    const completedFork = createRunNodeInstance({
      ...fork,
      revision: 1,
      status: 'succeeded',
      terminalAt: progressionTransactionNow,
    });
    const childScope = deriveChildForkScopeKey(fork.forkScopeKey, fork.activationId);
    const branch = (key: string) =>
      nodeFixture({
        activationId: `fold-${key}`,
        branchKey: key,
        createdAt: progressionTransactionNow,
        forkScopeKey: childScope,
        id: `fold-${key}-node`,
        nodeKey: key,
        parentActivationId: fork.activationId,
        updatedAt: progressionTransactionNow,
      });
    const branchA = branch('branch-a');
    const branchB = branch('branch-b');
    const join = nodeFixture({
      activationId: 'fold-join',
      branchKey: null,
      createdAt: progressionTransactionNow,
      forkScopeKey: childScope,
      id: 'fold-join-node',
      nodeKey: 'join',
      parentActivationId: fork.activationId,
      status: 'join_waiting',
      updatedAt: progressionTransactionNow,
    });
    const completedJoin = createRunNodeInstance({
      ...join,
      revision: 1,
      status: 'succeeded',
      terminalAt: progressionTransactionNow,
    });
    const successor = nodeFixture({
      activationId: 'fold-successor',
      branchKey: null,
      createdAt: progressionTransactionNow,
      forkScopeKey: childScope,
      id: 'fold-successor-node',
      nodeKey: 'successor',
      parentActivationId: join.activationId,
      updatedAt: progressionTransactionNow,
    });
    const forkCause = (branchKey: string | null, relation: 'entry' | 'join') =>
      ({
        branchKey,
        forkActivationId: fork.activationId,
        forkNodeKey: fork.nodeKey,
        kind: 'fork',
        predecessorActivationId: fork.activationId,
        predecessorNodeKey: fork.nodeKey,
        relation,
      }) as const;
    const nextState = {
      candidateVerdicts: [],
      commandReceipts: [initializeReceipt],
      gateResolutions: [],
      nodes: [
        { nodeKey: 'fork', outcome: 'selected', state: 'terminal' },
        { nodeKey: branchA.nodeKey, state: 'enabled' },
        { nodeKey: branchB.nodeKey, state: 'enabled' },
        { nodeKey: join.nodeKey, outcome: 'joined', state: 'terminal' },
        { nodeKey: successor.nodeKey, state: 'enabled' },
      ],
      occurrenceKey: 'occurrence-1',
      phase: 'active',
      schemaVersion: 1,
      terminal: null,
      values: [],
    } as const;

    const transition = applyRunProgression({
      intent: {
        nextState,
        receipt: initializeReceipt.result,
        steps: [
          { kind: 'initialize' },
          {
            cause: { kind: 'entry' },
            kind: 'activate_node',
            node: fork,
            nodeKey: fork.nodeKey,
            nodeKind: 'selector',
          },
          {
            kind: 'complete_selector',
            node: completedFork,
            nodeKey: fork.nodeKey,
            outcome: 'selected',
          },
          {
            cause: forkCause('branch-a', 'entry'),
            kind: 'activate_node',
            node: branchA,
            nodeKey: branchA.nodeKey,
            nodeKind: 'task',
          },
          {
            cause: forkCause('branch-b', 'entry'),
            kind: 'activate_node',
            node: branchB,
            nodeKey: branchB.nodeKey,
            nodeKind: 'task',
          },
          {
            cause: forkCause(null, 'join'),
            kind: 'activate_node',
            node: join,
            nodeKey: join.nodeKey,
            nodeKind: 'join',
          },
          {
            kind: 'complete_join',
            node: completedJoin,
            nodeKey: join.nodeKey,
            outcome: 'joined',
          },
          {
            cause: {
              kind: 'successor',
              predecessorActivationId: join.activationId,
              predecessorNodeKey: join.nodeKey,
            },
            kind: 'activate_node',
            node: successor,
            nodeKey: successor.nodeKey,
            nodeKind: 'task',
          },
        ],
      },
      projection: { attempts: [], nodes: [], outputs: [], run },
      transactionNow: progressionTransactionNow,
    });

    expect(transition.nodes).toHaveLength(5);
    expect(transition.nodes.filter((node) => node.id === fork.id)).toMatchObject([
      { id: completedFork.id, revision: 0, status: 'succeeded' },
    ]);
    expect(transition.eventIntents.map((event) => event.kind)).toEqual([
      'node.activated',
      'node.transitioned',
      'node.activated',
      'node.activated',
      'node.activated',
      'node.transitioned',
      'node.activated',
    ]);
    expect(transition.run).toMatchObject({
      createdAt: progressionTransactionNow,
      revision: 0,
      updatedAt: progressionTransactionNow,
    });
    expect(transition.nodes.every((node) => node.revision === 0)).toBe(true);

    const store = new LogicalRunStoreFake(progressionTransactionNow);
    const storeResult = await store.transaction((transaction) =>
      transaction.commit({
        expected: {
          absentNodes: transition.nodes.map((node) => ({
            activationId: node.activationId,
            activationKey: node.activationKey,
            forkScopeKey: node.forkScopeKey,
            nodeInstanceId: node.id,
            runId: node.runId,
          })),
          absentOutputIds: [],
          absentRunId: run.id,
          kind: 'create',
        },
        idempotency: {
          identity: {
            key: 'producer-init',
            operation: 'initialize_progression',
            runId: run.id,
            subjectId: run.id,
          },
          request: { operation: 'initialize' },
          result: initializeReceipt.result,
        },
        kind: 'apply_progression_transition',
        operation: 'initialize',
        transition,
        trigger: { kind: 'run', runId: run.id },
      }),
    );
    expect(storeResult).toMatchObject({ kind: 'committed' });
  });

  it('rejects join completion without exact join-waiting authority', () => {
    const priorState = {
      candidateVerdicts: [],
      commandReceipts: [initializeReceipt],
      gateResolutions: [],
      nodes: [
        { nodeKey: 'selector', state: 'enabled' },
        { nodeKey: 'join', state: 'enabled' },
      ],
      occurrenceKey: 'occurrence-1',
      phase: 'active',
      schemaVersion: 1,
      terminal: null,
      values: [],
    } as const;
    const run = createRun({ ...runFixture(), progression: priorState });
    const selector = nodeFixture({ nodeKey: 'selector', status: 'selector_waiting' });
    const receipt = progressionCommandReceipt('consensus_verdict');
    const nextState = {
      ...priorState,
      candidateVerdicts: [{ candidateKey: 'candidate-a', nodeKey: 'selector', verdict: 'approve' }],
      commandReceipts: [...priorState.commandReceipts, receipt],
      nodes: [
        { nodeKey: 'selector', state: 'enabled' },
        { nodeKey: 'join', outcome: 'joined', state: 'terminal' },
      ],
    } as const;

    for (const status of ['selector_waiting', 'gate_waiting', 'ready'] as const) {
      const wrongKind = nodeFixture({ id: 'join-node', nodeKey: 'join', status });
      const completed = createRunNodeInstance({
        ...wrongKind,
        activeAttemptId: null,
        revision: 1,
        status: 'succeeded',
        terminalAt: progressionTransactionNow,
        updatedAt: progressionTransactionNow,
      });
      expect(() =>
        applyRunProgression({
          intent: {
            nextState,
            receipt: receipt.result,
            steps: [
              { candidateKey: 'candidate-a', kind: 'record_verdict', nodeKey: 'selector' },
              { kind: 'complete_join', node: completed, nodeKey: 'join', outcome: 'joined' },
            ],
          },
          projection: { attempts: [], nodes: [selector, wrongKind], outputs: [], run },
          transactionNow: progressionTransactionNow,
        }),
      ).toThrow(TypeError);
    }
  });

  it('folds a verdict-origin selector follow-on before activating its successor', () => {
    const priorState = {
      candidateVerdicts: [],
      commandReceipts: [initializeReceipt],
      gateResolutions: [],
      nodes: [{ nodeKey: 'selector', state: 'enabled' }],
      occurrenceKey: 'occurrence-1',
      phase: 'active',
      schemaVersion: 1,
      terminal: null,
      values: [],
    } as const;
    const run = createRun({ ...runFixture(), progression: priorState });
    const selector = nodeFixture({ nodeKey: 'selector', status: 'selector_waiting' });
    const completed = createRunNodeInstance({
      ...selector,
      revision: 1,
      status: 'succeeded',
      terminalAt: progressionTransactionNow,
      updatedAt: progressionTransactionNow,
    });
    const successor = nodeFixture({
      activationId: 'successor-activation',
      createdAt: progressionTransactionNow,
      id: 'successor-node',
      nodeKey: 'successor',
      parentActivationId: selector.activationId,
      updatedAt: progressionTransactionNow,
    });
    const receipt = progressionCommandReceipt('consensus_verdict');
    const nextState = {
      ...priorState,
      candidateVerdicts: [{ candidateKey: 'candidate-a', nodeKey: 'selector', verdict: 'approve' }],
      commandReceipts: [...priorState.commandReceipts, receipt],
      nodes: [
        { nodeKey: 'selector', outcome: 'selected', state: 'terminal' },
        { nodeKey: 'successor', state: 'enabled' },
      ],
    } as const;

    const transition = applyRunProgression({
      intent: {
        nextState,
        receipt: receipt.result,
        steps: [
          { candidateKey: 'candidate-a', kind: 'record_verdict', nodeKey: 'selector' },
          {
            kind: 'complete_selector',
            node: completed,
            nodeKey: 'selector',
            outcome: 'selected',
          },
          {
            cause: {
              kind: 'successor',
              predecessorActivationId: selector.activationId,
              predecessorNodeKey: selector.nodeKey,
            },
            kind: 'activate_node',
            node: successor,
            nodeKey: successor.nodeKey,
            nodeKind: 'task',
          },
        ],
      },
      projection: { attempts: [], nodes: [selector], outputs: [], run },
      transactionNow: progressionTransactionNow,
    });

    expect(transition.nodes).toEqual([completed, successor]);
    expect(transition.eventIntents.map((event) => event.kind)).toEqual([
      'node.transitioned',
      'node.activated',
    ]);
    const completion = {
      kind: 'complete_selector',
      node: completed,
      nodeKey: 'selector',
      outcome: 'selected',
    } as const;
    expect(() =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: receipt.result,
          steps: [
            { candidateKey: 'candidate-a', kind: 'record_verdict', nodeKey: 'selector' },
            completion,
            completion,
          ],
        },
        projection: { attempts: [], nodes: [selector], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
    const alreadySucceeded = createRunNodeInstance({
      ...selector,
      status: 'succeeded',
      terminalAt: 1_500,
      updatedAt: 1_500,
    });
    expect(() =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: receipt.result,
          steps: [
            { candidateKey: 'candidate-a', kind: 'record_verdict', nodeKey: 'selector' },
            {
              ...completion,
              node: createRunNodeInstance({
                ...alreadySucceeded,
                revision: alreadySucceeded.revision + 1,
                updatedAt: progressionTransactionNow,
              }),
            },
          ],
        },
        projection: { attempts: [], nodes: [alreadySucceeded], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
    for (const status of ['gate_waiting', 'join_waiting'] as const) {
      const wrongKind = createRunNodeInstance({ ...selector, status });
      expect(() =>
        applyRunProgression({
          intent: {
            nextState,
            receipt: receipt.result,
            steps: [
              { candidateKey: 'candidate-a', kind: 'record_verdict', nodeKey: 'selector' },
              {
                ...completion,
                node: createRunNodeInstance({
                  ...wrongKind,
                  revision: 1,
                  status: 'succeeded',
                  terminalAt: progressionTransactionNow,
                  updatedAt: progressionTransactionNow,
                }),
              },
            ],
          },
          projection: { attempts: [], nodes: [wrongKind], outputs: [], run },
          transactionNow: progressionTransactionNow,
        }),
      ).toThrow(TypeError);
    }
  });

  it('derives exact fork activation coordinates from the named fork node', () => {
    const run = runFixture();
    const fork = nodeFixture({
      activationId: 'fork-activation',
      id: 'fork-node',
      nodeKey: 'fork',
      status: 'selector_waiting',
    });
    const childScope = deriveChildForkScopeKey(fork.forkScopeKey, fork.activationId);
    const child = nodeFixture({
      activationId: 'child-activation',
      branchKey: 'alpha',
      createdAt: progressionTransactionNow,
      forkScopeKey: childScope,
      id: 'child-node',
      nodeKey: 'child',
      parentActivationId: fork.activationId,
      updatedAt: progressionTransactionNow,
    });
    const nextState = {
      candidateVerdicts: [],
      commandReceipts: [initializeReceipt],
      gateResolutions: [],
      nodes: [
        { nodeKey: 'fork', state: 'enabled' },
        { nodeKey: 'child', state: 'enabled' },
      ],
      occurrenceKey: 'occurrence-1',
      phase: 'active',
      schemaVersion: 1,
      terminal: null,
      values: [],
    } as const;
    const step = {
      cause: {
        branchKey: 'alpha',
        forkActivationId: fork.activationId,
        forkNodeKey: 'fork',
        kind: 'fork',
        predecessorActivationId: fork.activationId,
        predecessorNodeKey: 'fork',
        relation: 'entry',
      },
      kind: 'activate_node',
      node: child,
      nodeKey: 'child',
      nodeKind: 'task',
    } as const;
    const apply = (
      activationStep: Extract<RunProgressionIntentStep, { readonly kind: 'activate_node' }>,
    ): unknown =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: initializeReceipt.result,
          steps: [{ kind: 'initialize' }, activationStep],
        },
        projection: { attempts: [], nodes: [fork], outputs: [], run },
        transactionNow: progressionTransactionNow,
      });

    expect(apply(step)).toMatchObject({ nodes: [{ forkScopeKey: childScope }] });
    expect(() =>
      apply({
        ...step,
        cause: { ...step.cause, forkNodeKey: 'changed-fork' },
      }),
    ).toThrow(TypeError);
    expect(() =>
      apply({
        ...step,
        node: nodeFixture({
          ...child,
          forkScopeKey: fork.forkScopeKey,
        }),
      }),
    ).toThrow(TypeError);
    const unrelated = nodeFixture({
      activationId: 'unrelated-activation',
      id: 'unrelated-node',
      nodeKey: 'unrelated',
      status: 'succeeded',
      terminalAt: 1_500,
      updatedAt: 1_500,
    });
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: {
            ...nextState,
            nodes: [
              ...nextState.nodes,
              { nodeKey: 'unrelated', outcome: 'done', state: 'terminal' },
            ],
          },
          receipt: initializeReceipt.result,
          steps: [
            { kind: 'initialize' },
            {
              ...step,
              cause: {
                ...step.cause,
                predecessorActivationId: unrelated.activationId,
                predecessorNodeKey: unrelated.nodeKey,
              },
              node: nodeFixture({
                ...child,
                parentActivationId: unrelated.activationId,
              }),
            },
          ],
        },
        projection: { attempts: [], nodes: [fork, unrelated], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
  });

  it.each(['entry', 'member', 'exit', 'join'] as const)(
    'binds fork %s to exact repeated-key predecessor and fork activations',
    (relation) => {
      const run = runFixture();
      const fork = nodeFixture({
        activationId: 'fork-current',
        id: 'fork-current-node',
        nodeKey: 'fork',
        status: 'selector_waiting',
      });
      const childScope = deriveChildForkScopeKey(fork.forkScopeKey, fork.activationId);
      const branchPredecessor = nodeFixture({
        activationId: 'branch-current',
        branchKey: 'alpha',
        forkScopeKey: childScope,
        id: 'branch-current-node',
        nodeKey: 'predecessor',
        parentActivationId: fork.activationId,
        status: 'succeeded',
        terminalAt: 1_500,
        updatedAt: 1_500,
      });
      const predecessor = relation === 'entry' || relation === 'join' ? fork : branchPredecessor;
      const child = nodeFixture({
        activationId: `${relation}-child`,
        branchKey: relation === 'join' ? null : 'alpha',
        createdAt: progressionTransactionNow,
        forkScopeKey: childScope,
        id: `${relation}-child-node`,
        nodeKey: `${relation}-child`,
        parentActivationId: predecessor.activationId,
        updatedAt: progressionTransactionNow,
      });
      const state = {
        candidateVerdicts: [],
        commandReceipts: [initializeReceipt],
        gateResolutions: [],
        nodes: [
          { nodeKey: 'fork', state: 'enabled' },
          ...(predecessor === fork
            ? []
            : [{ nodeKey: 'predecessor', outcome: 'done', state: 'terminal' as const }]),
          { nodeKey: child.nodeKey, state: 'enabled' },
        ],
        occurrenceKey: 'occurrence-1',
        phase: 'active',
        schemaVersion: 1,
        terminal: null,
        values: [],
      } as const;
      const step = {
        cause: {
          branchKey: relation === 'join' ? null : 'alpha',
          forkActivationId: fork.activationId,
          forkNodeKey: fork.nodeKey,
          kind: 'fork',
          predecessorActivationId: predecessor.activationId,
          predecessorNodeKey: predecessor.nodeKey,
          relation,
        },
        kind: 'activate_node',
        node: child,
        nodeKey: child.nodeKey,
        nodeKind: 'task',
      } as const;
      const projectionNodes = predecessor === fork ? [fork] : [fork, predecessor];
      const apply = (candidate: typeof step, nodes = projectionNodes) =>
        applyRunProgression({
          intent: {
            nextState: state,
            receipt: initializeReceipt.result,
            steps: [{ kind: 'initialize' }, candidate],
          },
          projection: { attempts: [], nodes, outputs: [], run },
          transactionNow: progressionTransactionNow,
        });

      expect(apply(step)).toMatchObject({ nodes: [{ id: child.id }] });
      const staleFork = nodeFixture({
        ...fork,
        activationId: 'fork-stale',
        id: 'fork-stale-node',
      });
      expect(() =>
        apply(
          {
            ...step,
            cause: { ...step.cause, forkActivationId: staleFork.activationId },
          },
          [...projectionNodes, staleFork],
        ),
      ).toThrow(TypeError);
      const stalePredecessor = nodeFixture({
        ...predecessor,
        activationId: 'predecessor-stale',
        id: 'predecessor-stale-node',
      });
      expect(() =>
        apply(
          {
            ...step,
            cause: {
              ...step.cause,
              predecessorActivationId: stalePredecessor.activationId,
            },
          },
          [...projectionNodes, stalePredecessor],
        ),
      ).toThrow(TypeError);
    },
  );

  it('materializes a task completion from the ordered semantic step', () => {
    const { run, state } = activeRun('task');
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
    const commandReceipt = progressionCommandReceipt('task_outcome');
    const nextState = {
      ...state,
      commandReceipts: [...state.commandReceipts, commandReceipt],
      nodes: [{ nodeKey: 'task', outcome: 'done', state: 'terminal' }],
    } as const;

    const transition = applyRunProgression({
      intent: {
        nextState,
        receipt: commandReceipt.result,
        steps: [
          {
            attempt: nextAttempt,
            kind: 'complete_task',
            node: nextNode,
            nodeKey: 'task',
            outcome: 'done',
            outputs: [],
          },
        ],
      },
      projection: { attempts: [attempt], nodes: [node], outputs: [], run },
      transactionNow: progressionTransactionNow,
    });

    expect(transition).toMatchObject({
      attempts: [{ id: attempt.id, status: 'succeeded' }],
      nodes: [{ id: node.id, status: 'succeeded' }],
      run: { revision: 1 },
    });
    const completedTaskStep = {
      attempt: nextAttempt,
      kind: 'complete_task',
      node: nextNode,
      nodeKey: 'task',
      outcome: 'done',
      outputs: [],
    } as const;
    expect(() =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: commandReceipt.result,
          steps: [completedTaskStep, completedTaskStep],
        },
        projection: { attempts: [attempt], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
    const repeatedOutput = outputFixture({
      correlation: {
        activationId: node.activationId,
        attemptId: nextAttempt.id,
        kind: 'attempt',
        nodeInstanceId: node.id,
      },
      createdAt: progressionTransactionNow,
      id: 'repeated-output',
      name: 'result',
      payload: { kind: 'json', value: 'value' },
    });
    const outputCommand = {
      ...commandReceipt,
      hostAttachment: {
        kind: 'task_outputs',
        outputs: [
          { name: repeatedOutput.name, payload: repeatedOutput.payload },
          { name: repeatedOutput.name, payload: repeatedOutput.payload },
        ],
      },
    } as const;
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: {
            ...nextState,
            commandReceipts: [...state.commandReceipts, outputCommand],
          },
          receipt: outputCommand.result,
          steps: [{ ...completedTaskStep, outputs: [repeatedOutput, repeatedOutput] }],
        },
        projection: { attempts: [attempt], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: commandReceipt.result,
          steps: [
            {
              attempt: nextAttempt,
              kind: 'complete_task',
              node: createRunNodeInstance({
                ...nextNode,
                activationId: 'rewritten-activation',
              }),
              nodeKey: 'task',
              outcome: 'done',
              outputs: [],
            },
          ],
        },
        projection: { attempts: [attempt], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: commandReceipt.result,
          steps: [
            {
              attempt: createAttempt({ ...nextAttempt, fencingToken: 99 }),
              kind: 'complete_task',
              node: nextNode,
              nodeKey: 'task',
              outcome: 'done',
              outputs: [],
            },
          ],
        },
        projection: { attempts: [attempt], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);

    const failedCommand = {
      ...commandReceipt,
      hostAttachment: { kind: 'none' } as const,
      semanticRequest: {
        kind: 'task_outcome' as const,
        nodeKey: 'task',
        outcome: {
          faultCode: 'EXECUTOR_UNAVAILABLE',
          faultMessage: 'Execution failed.',
          kind: 'failed' as const,
        },
      },
    };
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: {
            ...nextState,
            commandReceipts: [...state.commandReceipts, failedCommand],
          },
          receipt: failedCommand.result,
          steps: [
            {
              attempt: nextAttempt,
              kind: 'complete_task',
              node: nextNode,
              nodeKey: 'task',
              outcome: 'done',
              outputs: [],
            },
          ],
        },
        projection: { attempts: [attempt], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
  });

  it.each([
    ['claimed', 'cancelled', 'pre_start_cancellation'],
    ['start_committed', 'succeeded', 'direct_success'],
    ['start_committed', 'failed', 'direct_failure'],
    ['start_committed', 'cancelled', 'direct_cancellation'],
    ['unknown', 'succeeded', 'late_success'],
    ['unknown', 'failed', 'late_failure'],
    ['unknown', 'cancelled', 'late_cancellation'],
    ['reconciling', 'succeeded', 'reconciled_success'],
    ['reconciling', 'failed', 'reconciled_failure'],
    ['reconciling', 'cancelled', 'reconciled_cancellation'],
  ] as const)(
    'derives the exact %s -> %s Attempt event before its node event',
    (priorStatus, nextStatus, cause) => {
      const { run, state } = activeRun('task');
      const attempt = attemptFixture({ status: priorStatus });
      const node = nodeFixture({
        activeAttemptId: attempt.id,
        nodeKey: 'task',
        status:
          priorStatus === 'unknown' || priorStatus === 'reconciling' ? 'unknown' : 'executing',
      });
      const fault =
        nextStatus === 'failed'
          ? { code: 'EXECUTOR_UNAVAILABLE' as const, message: 'Execution failed.' }
          : null;
      const nextAttempt = createAttempt({
        ...attempt,
        fault,
        revision: attempt.revision + 1,
        status: nextStatus,
        terminalAt: progressionTransactionNow,
        updatedAt: progressionTransactionNow,
      });
      const nextNode = createRunNodeInstance({
        ...node,
        activeAttemptId: null,
        revision: node.revision + 1,
        status: nextStatus,
        terminalAt: progressionTransactionNow,
        terminalFault: fault,
        updatedAt: progressionTransactionNow,
      });
      const baseReceipt = progressionCommandReceipt('task_outcome');
      const semanticOutcome =
        nextStatus === 'succeeded'
          ? { kind: 'succeeded' as const, values: [] }
          : nextStatus === 'failed'
            ? {
                faultCode: fault?.code ?? 'EXECUTOR_UNAVAILABLE',
                faultMessage: fault?.message ?? 'Execution failed.',
                kind: 'failed' as const,
              }
            : { kind: 'cancelled' as const };
      const commandReceipt = {
        ...baseReceipt,
        hostAttachment:
          nextStatus === 'succeeded' ? baseReceipt.hostAttachment : ({ kind: 'none' } as const),
        semanticRequest: {
          kind: 'task_outcome' as const,
          nodeKey: 'task',
          outcome: semanticOutcome,
        },
      };
      const nextState = {
        ...state,
        commandReceipts: [...state.commandReceipts, commandReceipt],
        nodes: [{ nodeKey: 'task', outcome: nextStatus, state: 'terminal' }],
      } as const;

      const transition = applyRunProgression({
        intent: {
          nextState,
          receipt: commandReceipt.result,
          steps: [
            {
              attempt: nextAttempt,
              kind: 'complete_task',
              node: nextNode,
              nodeKey: 'task',
              outcome: nextStatus,
              outputs: [],
            },
          ],
        },
        projection: { attempts: [attempt], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      });

      expect(transition.eventIntents).toHaveLength(2);
      expect(transition.eventIntents[0]).toMatchObject({
        correlation: {
          activationId: node.activationId,
          attemptId: attempt.id,
          kind: 'attempt',
          nodeInstanceId: node.id,
        },
        kind: 'attempt.transitioned',
        payload: { cause, from: priorStatus, to: nextStatus },
        runId: run.id,
      });
      expect(transition.eventIntents[1]).toMatchObject({
        correlation: {
          activationId: node.activationId,
          kind: 'node',
          nodeInstanceId: node.id,
        },
        kind: 'node.transitioned',
        runId: run.id,
      });
    },
  );

  it('rejects an Attempt transition with no semantic event mapping', () => {
    const { run, state } = activeRun('task');
    const attempt = attemptFixture({ status: 'claimed' });
    const node = nodeFixture({
      activeAttemptId: attempt.id,
      nodeKey: 'task',
      status: 'executing',
    });
    const nextAttempt = createAttempt({
      ...attempt,
      revision: 1,
      startCommittedAt: progressionTransactionNow,
      status: 'start_committed',
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
    const commandReceipt = progressionCommandReceipt('task_outcome');
    const nextState = {
      ...state,
      commandReceipts: [...state.commandReceipts, commandReceipt],
      nodes: [{ nodeKey: 'task', outcome: 'done', state: 'terminal' }],
    } as const;

    expect(() =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: commandReceipt.result,
          steps: [
            {
              attempt: nextAttempt,
              kind: 'complete_task',
              node: nextNode,
              nodeKey: 'task',
              outcome: 'done',
              outputs: [],
            },
          ],
        },
        projection: { attempts: [attempt], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
  });

  it('materializes a human-gate resolution and its exact output', () => {
    const { run, state } = activeRun('gate');
    const node = nodeFixture({ nodeKey: 'gate', status: 'gate_waiting' });
    const nextNode = createRunNodeInstance({
      ...node,
      revision: 1,
      status: 'succeeded',
      terminalAt: progressionTransactionNow,
      updatedAt: progressionTransactionNow,
    });
    const output = outputFixture({
      correlation: {
        activationId: node.activationId,
        kind: 'node',
        nodeInstanceId: node.id,
      },
      createdAt: progressionTransactionNow,
      id: 'gate-output',
      name: 'answer',
      payload: { kind: 'json', value: 'yes' },
    });
    const commandReceipt = progressionCommandReceipt('human_gate_resolution');
    const nextState = {
      ...state,
      commandReceipts: [...state.commandReceipts, commandReceipt],
      gateResolutions: [{ nodeKey: 'gate', resolution: 'approved' }],
      nodes: [{ nodeKey: 'gate', outcome: 'approved', state: 'terminal' }],
    } as const;

    const transition = applyRunProgression({
      intent: {
        nextState,
        receipt: commandReceipt.result,
        steps: [
          {
            kind: 'resolve_gate',
            node: nextNode,
            nodeKey: 'gate',
            output,
          },
        ],
      },
      projection: { attempts: [], nodes: [node], outputs: [], run },
      transactionNow: progressionTransactionNow,
    });

    expect(transition.outputs).toEqual([output]);
    expect(transition.nodes[0]?.status).toBe('succeeded');
    const gateStep = {
      kind: 'resolve_gate',
      node: nextNode,
      nodeKey: 'gate',
      output,
    } as const;
    expect(() =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: commandReceipt.result,
          steps: [gateStep, gateStep],
        },
        projection: { attempts: [], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: commandReceipt.result,
          steps: [
            {
              kind: 'resolve_gate',
              node: nextNode,
              nodeKey: 'gate',
              output: {
                ...output,
                payload: { kind: 'json', value: 'foreign' },
                runId: 'foreign-run',
              },
            },
          ],
        },
        projection: { attempts: [], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
    for (const status of ['selector_waiting', 'join_waiting'] as const) {
      const wrongKind = createRunNodeInstance({ ...node, status });
      expect(() =>
        applyRunProgression({
          intent: {
            nextState,
            receipt: commandReceipt.result,
            steps: [
              {
                ...gateStep,
                node: createRunNodeInstance({
                  ...wrongKind,
                  revision: 1,
                  status: 'succeeded',
                  terminalAt: progressionTransactionNow,
                  updatedAt: progressionTransactionNow,
                }),
              },
            ],
          },
          projection: { attempts: [], nodes: [wrongKind], outputs: [], run },
          transactionNow: progressionTransactionNow,
        }),
      ).toThrow(TypeError);
    }
  });

  it('records a consensus verdict without inventing an operational delta', () => {
    const { run, state } = activeRun('selector');
    const node = nodeFixture({ nodeKey: 'selector', status: 'selector_waiting' });
    const commandReceipt = progressionCommandReceipt('consensus_verdict');
    const nextState = {
      ...state,
      candidateVerdicts: [{ candidateKey: 'candidate-a', nodeKey: 'selector', verdict: 'approve' }],
      commandReceipts: [...state.commandReceipts, commandReceipt],
    } as const;

    const transition = applyRunProgression({
      intent: {
        nextState,
        receipt: commandReceipt.result,
        steps: [
          {
            candidateKey: 'candidate-a',
            kind: 'record_verdict',
            nodeKey: 'selector',
          },
        ],
      },
      projection: { attempts: [], nodes: [node], outputs: [], run },
      transactionNow: progressionTransactionNow,
    });

    expect(transition.nodes).toEqual([]);
    expect(transition.run.progression.candidateVerdicts).toHaveLength(1);
    const verdictStep = {
      candidateKey: 'candidate-a',
      kind: 'record_verdict',
      nodeKey: 'selector',
    } as const;
    expect(() =>
      applyRunProgression({
        intent: {
          nextState,
          receipt: commandReceipt.result,
          steps: [verdictStep, verdictStep],
        },
        projection: { attempts: [], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
  });

  it('rejects deletion or rewriting of prior semantic history', () => {
    const priorState = {
      candidateVerdicts: [{ candidateKey: 'old', nodeKey: 'selector', verdict: 'approve' }],
      commandReceipts: [initializeReceipt],
      gateResolutions: [],
      nodes: [{ nodeKey: 'selector', state: 'enabled' }],
      occurrenceKey: 'occurrence-1',
      phase: 'active',
      schemaVersion: 1,
      terminal: null,
      values: [{ key: 'input', source: { kind: 'init' }, value: 1 }],
    } as const;
    const run = createRun({ ...runFixture(), progression: priorState });
    const node = nodeFixture({ nodeKey: 'selector', status: 'selector_waiting' });
    const receipt = progressionCommandReceipt('consensus_verdict');
    const rewrittenState = {
      ...priorState,
      candidateVerdicts: [
        { candidateKey: 'old', nodeKey: 'selector', verdict: 'reject' },
        { candidateKey: 'candidate-a', nodeKey: 'selector', verdict: 'approve' },
      ],
      commandReceipts: [...priorState.commandReceipts, receipt],
      values: [],
    } as const;

    expect(() =>
      applyRunProgression({
        intent: {
          nextState: rewrittenState,
          receipt: receipt.result,
          steps: [
            {
              candidateKey: 'candidate-a',
              kind: 'record_verdict',
              nodeKey: 'selector',
            },
          ],
        },
        projection: { attempts: [], nodes: [node], outputs: [], run },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
  });

  it('selects a terminal outcome and retires inactive sibling authority', () => {
    const selectedAttempt = attemptFixture({ status: 'start_committed' });
    const selectedNode = nodeFixture({
      activeAttemptId: selectedAttempt.id,
      nodeKey: 'task',
      status: 'executing',
    });
    const siblingNode = nodeFixture({
      activationId: 'sibling-activation',
      id: 'sibling-node',
      nodeKey: 'sibling',
    });
    const startedAttempt = attemptFixture({
      id: 'started-attempt',
      nodeInstanceId: 'started-node',
      status: 'unknown',
    });
    const startedNode = nodeFixture({
      activationId: 'started-activation',
      activeAttemptId: startedAttempt.id,
      id: 'started-node',
      nodeKey: 'started',
      status: 'unknown',
    });
    const claimedAttempt = attemptFixture({
      id: 'claimed-attempt',
      nodeInstanceId: 'claimed-node',
    });
    const claimedNode = nodeFixture({
      activationId: 'claimed-activation',
      activeAttemptId: claimedAttempt.id,
      id: 'claimed-node',
      nodeKey: 'claimed',
      status: 'executing',
    });
    const state = {
      candidateVerdicts: [],
      commandReceipts: [initializeReceipt],
      gateResolutions: [],
      nodes: [
        { nodeKey: 'task', state: 'enabled' },
        { nodeKey: 'sibling', state: 'enabled' },
        { nodeKey: 'started', state: 'enabled' },
        { nodeKey: 'claimed', state: 'enabled' },
      ],
      occurrenceKey: 'occurrence-1',
      phase: 'active',
      schemaVersion: 1,
      terminal: null,
      values: [],
    } as const;
    const run = createRun({ ...runFixture(), progression: state });
    const nextAttempt = createAttempt({
      ...selectedAttempt,
      revision: 1,
      status: 'succeeded',
      terminalAt: progressionTransactionNow,
      updatedAt: progressionTransactionNow,
    });
    const nextSelected = createRunNodeInstance({
      ...selectedNode,
      activeAttemptId: null,
      revision: 1,
      status: 'succeeded',
      terminalAt: progressionTransactionNow,
      updatedAt: progressionTransactionNow,
    });
    const nextSibling = createRunNodeInstance({
      ...siblingNode,
      revision: 1,
      status: 'retired',
      terminalAt: progressionTransactionNow,
      updatedAt: progressionTransactionNow,
    });
    const nextStartedAttempt = createAttempt({
      ...startedAttempt,
      progressionClosedAt: progressionTransactionNow,
      revision: 1,
      updatedAt: progressionTransactionNow,
    });
    const nextStartedNode = createRunNodeInstance({
      ...startedNode,
      revision: 1,
      status: 'retiring',
      updatedAt: progressionTransactionNow,
    });
    const nextClaimedAttempt = createAttempt({
      ...claimedAttempt,
      revision: 1,
      status: 'cancelled',
      terminalAt: progressionTransactionNow,
      updatedAt: progressionTransactionNow,
    });
    const nextClaimedNode = createRunNodeInstance({
      ...claimedNode,
      activeAttemptId: null,
      revision: 1,
      status: 'retired',
      terminalAt: progressionTransactionNow,
      updatedAt: progressionTransactionNow,
    });
    const waitingCommand = progressionCommandReceipt('task_outcome');
    const terminalResult = {
      ...waitingCommand.result,
      outcome: {
        kind: 'terminal',
        terminal: {
          fault: null,
          nodeKey: 'task',
          outcome: 'done',
          status: 'succeeded',
        },
      },
    } as const;
    const terminalCommand = { ...waitingCommand, result: terminalResult };
    const terminal = { nodeKey: 'task', outcome: 'done' } as const;
    const nextState = {
      ...state,
      commandReceipts: [...state.commandReceipts, terminalCommand],
      nodes: [
        { nodeKey: 'task', outcome: 'done', state: 'terminal' },
        { nodeKey: 'sibling', state: 'retired', terminal },
        { nodeKey: 'started', state: 'retired', terminal },
        { nodeKey: 'claimed', state: 'retired', terminal },
      ],
      phase: 'terminal',
      terminal,
    } as const;

    const input = {
      intent: {
        nextState,
        receipt: terminalResult,
        steps: [
          {
            attempt: nextAttempt,
            kind: 'complete_task',
            node: nextSelected,
            nodeKey: 'task',
            outcome: 'done',
            outputs: [],
          },
          {
            kind: 'terminate',
            nodeKey: 'task',
            outcome: 'done',
            retirements: [
              { attempt: null, node: nextSibling },
              { attempt: nextStartedAttempt, node: nextStartedNode },
              { attempt: nextClaimedAttempt, node: nextClaimedNode },
            ],
          },
        ],
      },
      projection: {
        attempts: [selectedAttempt, startedAttempt, claimedAttempt],
        nodes: [selectedNode, siblingNode, startedNode, claimedNode],
        outputs: [],
        run,
      },
      transactionNow: progressionTransactionNow,
    } as const;
    const transition = applyRunProgression(input);

    expect(transition.run).toMatchObject({
      status: 'succeeded',
      terminalAt: progressionTransactionNow,
    });
    expect(transition.nodes.map((node) => node.status)).toEqual([
      'succeeded',
      'retired',
      'retiring',
      'retired',
    ]);
    expect(() =>
      applyRunProgression({
        ...input,
        intent: {
          ...input.intent,
          steps: [input.intent.steps[0], input.intent.steps[1], input.intent.steps[1]],
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        ...input,
        intent: {
          ...input.intent,
          steps: [
            input.intent.steps[0],
            input.intent.steps[1],
            {
              kind: 'complete_selector',
              node: nextSelected,
              nodeKey: 'task',
              outcome: 'done',
            },
          ],
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        ...input,
        intent: {
          ...input.intent,
          steps: [
            input.intent.steps[0],
            input.intent.steps[1],
            {
              cause: { kind: 'entry' },
              kind: 'activate_node',
              node: nextSibling,
              nodeKey: 'late',
              nodeKind: 'task',
            },
          ],
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        ...input,
        intent: {
          ...input.intent,
          steps: [
            input.intent.steps[0],
            {
              ...input.intent.steps[1],
              retirements: [
                { attempt: null, node: nextSibling },
                {
                  attempt: createAttempt({
                    ...nextStartedAttempt,
                    fault: {
                      code: 'UNKNOWN_OUTCOME',
                      message: 'Rewritten reconciliation evidence.',
                    },
                  }),
                  node: nextStartedNode,
                },
                { attempt: nextClaimedAttempt, node: nextClaimedNode },
              ],
            },
          ],
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        ...input,
        intent: { ...input.intent, steps: [input.intent.steps[0]] },
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        ...input,
        intent: { ...input.intent, receipt: waitingCommand.result },
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        ...input,
        intent: {
          ...input.intent,
          steps: [input.intent.steps[0], { ...input.intent.steps[1], nodeKey: 'sibling' }],
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyRunProgression({
        ...input,
        intent: {
          ...input.intent,
          steps: [input.intent.steps[0], { ...input.intent.steps[1], outcome: 'different' }],
        },
      }),
    ).toThrow(TypeError);
  });

  it('settles one progression-closed Attempt without mutating the terminal Run', () => {
    const terminal = { nodeKey: 'terminal', outcome: 'done' } as const;
    const state = {
      candidateVerdicts: [],
      commandReceipts: [initializeReceipt],
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
    const selected = nodeFixture({
      nodeKey: 'terminal',
      status: 'succeeded',
      terminalAt: 1_500,
      updatedAt: 1_500,
    });
    const priorAttempt = attemptFixture({
      progressionClosedAt: 1_500,
      status: 'start_committed',
      updatedAt: 1_500,
    });
    const priorNode = nodeFixture({
      activationId: 'retiring-activation',
      activeAttemptId: priorAttempt.id,
      id: 'retiring-node',
      nodeKey: 'retiring',
      status: 'retiring',
      updatedAt: 1_500,
    });
    const nextAttempt = createAttempt({
      ...priorAttempt,
      revision: 1,
      status: 'succeeded',
      terminalAt: progressionTransactionNow,
      updatedAt: progressionTransactionNow,
    });
    const nextNode = createRunNodeInstance({
      ...priorNode,
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
        nodeKey: 'retiring',
        status: 'succeeded',
        terminalAt: nextAttempt.terminalAt!,
      },
      occurrenceKey: 'occurrence-1',
      operation: 'retired_attempt_observation',
      outcome: {
        kind: 'terminal',
        terminal: { fault: null, nodeKey: 'terminal', outcome: 'done', status: 'succeeded' },
      },
      schemaVersion: 1,
    } as const;

    const transition = applyRunProgression({
      intent: {
        nextState: state,
        receipt,
        steps: [
          {
            attempt: nextAttempt,
            attemptId: priorAttempt.id,
            kind: 'settle_retired_attempt',
            node: nextNode,
            nodeKey: 'retiring',
          },
        ],
      },
      projection: {
        attempts: [priorAttempt],
        nodes: [selected, priorNode],
        outputs: [],
        run,
      },
      transactionNow: progressionTransactionNow,
    });

    expect(transition.run).toBe(run);
    expect(transition.eventIntents).toEqual([]);
    expect(transition.outputs).toEqual([]);
    expect(transition.nodes[0]?.status).toBe('retired');
    const cleanupStep = {
      attempt: nextAttempt,
      attemptId: priorAttempt.id,
      kind: 'settle_retired_attempt',
      node: nextNode,
      nodeKey: 'retiring',
    } as const;
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: {
            ...state,
            nodes: [state.nodes[0], { nodeKey: 'retiring', outcome: 'forged', state: 'terminal' }],
          },
          receipt,
          steps: [cleanupStep],
        },
        projection: {
          attempts: [priorAttempt],
          nodes: [selected, priorNode],
          outputs: [],
          run,
        },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrowError('Run progression node history is invalid.');
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: state,
          receipt,
          steps: [cleanupStep, cleanupStep],
        },
        projection: {
          attempts: [priorAttempt],
          nodes: [selected, priorNode],
          outputs: [],
          run,
        },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
    const unknownAttempt = createAttempt({
      ...priorAttempt,
      fault: { code: 'UNKNOWN_OUTCOME', message: 'Original reconciliation evidence.' },
      status: 'unknown',
    });
    expect(() =>
      applyRunProgression({
        intent: {
          nextState: state,
          receipt,
          steps: [
            {
              attempt: createAttempt({
                ...unknownAttempt,
                fault: {
                  code: 'EXECUTOR_UNAVAILABLE',
                  message: 'Unverified cleanup failure.',
                  retryable: false,
                },
                revision: 1,
                status: 'failed',
                terminalAt: progressionTransactionNow,
                updatedAt: progressionTransactionNow,
              }),
              attemptId: unknownAttempt.id,
              kind: 'settle_retired_attempt',
              node: nextNode,
              nodeKey: 'retiring',
            },
          ],
        },
        projection: {
          attempts: [unknownAttempt],
          nodes: [selected, priorNode],
          outputs: [],
          run,
        },
        transactionNow: progressionTransactionNow,
      }),
    ).toThrow(TypeError);
  });
});
