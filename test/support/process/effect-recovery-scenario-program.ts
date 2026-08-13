import assert from 'node:assert/strict';

import Type from 'typebox';
import Schema from 'typebox/schema';

import { NodeOutputSchema } from '../../../src/contracts/pipeline/node-output.js';
import type { JsonValue, NodeOutput } from '../../../src/index.js';
import type { RunScenario, ScenarioStep } from '../../dsl/scenario.js';

export const RecoveryInstructionSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('effectCompleted'), output: Type.Optional(NodeOutputSchema) },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('effectFailed') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('effectNotFound') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('outcomeUnknown') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('reconciliationFailed') }, { additionalProperties: false }),
]);

export type RecoveryInstruction = Type.Static<typeof RecoveryInstructionSchema>;

const instructionsValidator = Schema.Compile(Type.Array(RecoveryInstructionSchema));

export const parseRecoveryInstructions = (value: unknown): readonly RecoveryInstruction[] => {
  if (!instructionsValidator.Check(value)) {
    throw new Error('Recovery process instructions are invalid.');
  }
  return value;
};

interface CompletionInstruction {
  readonly attempt: number;
  readonly outcome: string;
  readonly output?: NodeOutput;
  readonly path: string;
}

interface ExpectedRecoveryEvent {
  readonly path?: string;
  readonly type: string;
}

export interface EffectRecoveryScenarioProgram {
  readonly completion?: CompletionInstruction;
  readonly crashMoment: 'afterEffect' | 'beforeEffect';
  readonly expectedEvents: readonly ExpectedRecoveryEvent[];
  readonly expectedExecutionCount?: number;
  readonly expectedNodeExecutions: readonly string[];
  readonly expectedStatus: 'failed' | 'succeeded';
  readonly input: JsonValue;
  readonly instructions: readonly RecoveryInstruction[];
  readonly path: string;
}

const recoveryInstruction = (
  step: Extract<ScenarioStep, { readonly kind: 'reconcileNode' }>,
): RecoveryInstruction =>
  step.result === 'effectCompleted'
    ? { kind: step.result, ...(step.output === undefined ? {} : { output: step.output }) }
    : { kind: step.result };

const stepPath = (step: ScenarioStep): string | undefined => {
  if (step.kind === 'expectEvent') {
    return step.event.path;
  }
  if (step.kind === 'expectNodeExecutions') {
    return step.paths.length === 1 ? step.paths[0] : undefined;
  }
  if ('path' in step && typeof step.path === 'string') {
    return step.path;
  }
  return undefined;
};

export const compileEffectRecoveryScenario = (
  scenario: RunScenario,
): EffectRecoveryScenarioProgram => {
  let completion: CompletionInstruction | undefined;
  let crashMoment: EffectRecoveryScenarioProgram['crashMoment'] | undefined;
  let expectedExecutionCount: number | undefined;
  let expectedStatus: EffectRecoveryScenarioProgram['expectedStatus'] | undefined;
  let input: JsonValue | undefined;
  let restartObserved = false;
  let startObserved = false;
  const expectedEvents: ExpectedRecoveryEvent[] = [];
  const expectedNodeExecutions: string[] = [];
  const instructions: RecoveryInstruction[] = [];
  const paths = new Set<string>();

  for (const step of scenario.steps) {
    const path = stepPath(step);
    if (path !== undefined) {
      paths.add(path);
    }
    switch (step.kind) {
      case 'startRun':
        assert(!startObserved && crashMoment === undefined, 'Recovery scenario must start once.');
        startObserved = true;
        input = step.input;
        break;
      case 'crashManager':
        assert(startObserved && crashMoment === undefined, 'Recovery scenario crash is misplaced.');
        assert(step.moment !== 'whileWaiting', 'Waiting recovery belongs to RR-07.');
        crashMoment = step.moment;
        break;
      case 'restartManager':
        assert(crashMoment !== undefined && !restartObserved, 'Recovery restart is misplaced.');
        restartObserved = true;
        break;
      case 'reconcileNode':
        assert(restartObserved, 'Reconciliation must follow process recovery.');
        instructions.push(recoveryInstruction(step));
        break;
      case 'completeNode':
        assert(restartObserved && completion === undefined, 'Completion is misplaced.');
        completion = {
          path: step.path,
          attempt: step.attempt,
          outcome: step.outcome,
          ...(step.output === undefined ? {} : { output: step.output }),
        };
        break;
      case 'expectEvent':
        expectedEvents.push({
          type: step.event.type,
          ...(step.event.path === undefined ? {} : { path: step.event.path }),
        });
        break;
      case 'expectExecutionCount':
        expectedExecutionCount = step.count;
        break;
      case 'expectNoDuplicateExecution':
        expectedExecutionCount = 1;
        break;
      case 'expectNodeExecutions':
        expectedNodeExecutions.push(...step.paths);
        break;
      case 'expectRunStatus':
        assert(step.status === 'failed' || step.status === 'succeeded');
        expectedStatus = step.status;
        break;
      case 'advanceTime':
      case 'answerHumanGate':
      case 'cancelRun':
      case 'captureAttemptId':
      case 'captureRunState':
      case 'captureCursorFromAnotherRun':
      case 'completeConsensusParticipant':
      case 'expectAgentExecution':
      case 'expectCommandResult':
      case 'expectDistinctCommandIds':
      case 'expectExecutorAborted':
      case 'expectCursorOrder':
      case 'expectHumanGateWaiting':
      case 'expectIteration':
      case 'expectJsonOutput':
      case 'expectMaximumActiveExecutions':
      case 'expectNoActiveDurableScopes':
      case 'expectNoNodeExecution':
      case 'expectNodeInput':
      case 'expectOutputValue':
      case 'expectPlanRejected':
      case 'expectRunDetails':
      case 'expectResolutionDetails':
      case 'expectRunStateUnchanged':
      case 'expectScopeStatuses':
      case 'expectSecretAbsent':
      case 'expectSecretResolved':
      case 'expectSubscriptionError':
      case 'expectVersionedScriptExecution':
      case 'failInputResolution':
      case 'failNode':
      case 'ignoreExecutorAbort':
      case 'resolveUnknownOutcome':
      case 'resumeSubscription':
        throw new Error(`Recovery scenario step ${step.kind} is not supported.`);
    }
  }

  assert(startObserved, 'Recovery scenario has no startRun step.');
  assert(crashMoment !== undefined, 'Recovery scenario has no crash boundary.');
  assert(restartObserved, 'Recovery scenario has no restartManager step.');
  assert(expectedStatus !== undefined, 'Recovery scenario has no terminal expectation.');
  assert(input !== undefined, 'Recovery scenario has no input.');
  assert(paths.size === 1, 'Recovery scenario must address exactly one effect path.');
  const path = [...paths][0];
  assert(path !== undefined);
  if (crashMoment === 'beforeEffect') {
    assert(instructions.length === 0, 'Before-effect recovery cannot reconcile an effect.');
    assert(completion?.attempt === 1, 'Before-effect recovery must complete attempt one.');
  } else {
    assert(instructions.length > 0, 'Ambiguous recovery must declare reconciliation results.');
    const finalInstruction = instructions.at(-1);
    if (finalInstruction?.kind === 'effectNotFound') {
      assert(completion?.attempt === 2, 'A proven-absent effect must complete attempt two.');
    } else {
      assert(completion === undefined, 'Only a proven-absent effect permits a new execution.');
    }
  }

  return {
    ...(completion === undefined ? {} : { completion }),
    crashMoment,
    expectedEvents,
    ...(expectedExecutionCount === undefined ? {} : { expectedExecutionCount }),
    expectedNodeExecutions,
    expectedStatus,
    input,
    instructions,
    path,
  };
};
