import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { RunScenario } from '../../dsl/scenario.js';
import {
  compileEffectRecoveryScenario,
  type EffectRecoveryScenarioProgram,
} from './effect-recovery-scenario-program.js';
import { RecoveryProcess, type RecoveryWorkerMessage } from './recovery-process.js';

const reportedNodeInstanceId = (event: { readonly data: unknown }): string | undefined => {
  if (typeof event.data !== 'object' || event.data === null || !('nodeInstanceId' in event.data)) {
    return undefined;
  }
  return typeof event.data.nodeInstanceId === 'string' ? event.data.nodeInstanceId : undefined;
};

const waitForObservation = async (process: RecoveryProcess): Promise<void> => {
  await process.waitFor({ kind: 'stopped' });
};

const assertProgramObservation = (
  program: EffectRecoveryScenarioProgram,
  firstProcess: RecoveryProcess,
  recoveredProcess: RecoveryProcess,
  dispatch: RecoveryWorkerMessage,
): void => {
  const executionCount =
    firstProcess.dispatched(program.path) + recoveredProcess.dispatched(program.path);
  if (program.expectedExecutionCount !== undefined) {
    assert.equal(executionCount, program.expectedExecutionCount);
  }
  for (const path of program.expectedNodeExecutions) {
    assert(firstProcess.dispatched(path) + recoveredProcess.dispatched(path) > 0);
  }

  const attempts = recoveredProcess.reportedAttempts();
  const effectCompleted = program.instructions.find(
    (instruction) => instruction.kind === 'effectCompleted',
  );
  if (effectCompleted?.kind === 'effectCompleted') {
    const attempt = attempts.find(({ ordinal }) => ordinal === 1);
    assert.equal(attempt?.status, 'completed');
    assert.deepStrictEqual(attempt?.output, effectCompleted.output);
  }
  const unknownRound = program.instructions.findIndex(
    (instruction) => instruction.kind === 'outcomeUnknown',
  );
  if (unknownRound >= 0) {
    const attempt = attempts.find(({ ordinal }) => ordinal === 1);
    assert.equal(attempt?.status, 'outcomeUnknown');
    assert.deepStrictEqual(attempt?.recovery, { reconciliationRound: unknownRound + 1 });
  }
  if (program.completion !== undefined) {
    const attempt = attempts.find(({ ordinal }) => ordinal === program.completion?.attempt);
    assert.equal(attempt?.status, 'completed');
    assert.deepStrictEqual(attempt?.output, program.completion.output);
  }

  const events = recoveredProcess.reportedEvents();
  for (const expected of program.expectedEvents) {
    assert(
      events.some(
        (event) =>
          event.type === expected.type &&
          (expected.path === undefined ||
            (expected.path === program.path &&
              reportedNodeInstanceId(event) === dispatch.nodeInstanceId)),
      ),
      `Missing ${expected.type} for ${expected.path ?? 'the run'}.`,
    );
  }
};

const processOptions = (program: EffectRecoveryScenarioProgram) => ({
  input: program.input,
  instructions: program.instructions,
  pauseBeforeIntent: program.crashMoment === 'beforeEffect',
});

const runBeforeEffectRecovery = async (
  scenario: RunScenario,
  program: EffectRecoveryScenarioProgram,
  runId: string,
): Promise<void> => {
  const firstProcess = new RecoveryProcess(
    'start',
    runId,
    scenario.intentId,
    undefined,
    processOptions(program),
  );
  let recoveredProcess: RecoveryProcess | undefined;
  try {
    await firstProcess.waitFor({ kind: 'beforeIntent' });
    await firstProcess.kill();

    recoveredProcess = new RecoveryProcess(
      'recover',
      runId,
      scenario.intentId,
      undefined,
      processOptions(program),
    );
    const dispatch = await recoveredProcess.waitFor({
      kind: 'dispatched',
      path: program.path,
      attemptOrdinal: 1,
    });
    assert(program.completion !== undefined);
    recoveredProcess.complete(program.path, program.completion);
    await recoveredProcess.waitFor({ kind: 'terminal', status: program.expectedStatus });
    await waitForObservation(recoveredProcess);
    assertProgramObservation(program, firstProcess, recoveredProcess, dispatch);
  } finally {
    await firstProcess.kill();
    await recoveredProcess?.kill();
  }
};

const runAmbiguousEffectRecovery = async (
  scenario: RunScenario,
  program: EffectRecoveryScenarioProgram,
  runId: string,
): Promise<void> => {
  const firstProcess = new RecoveryProcess(
    'start',
    runId,
    scenario.intentId,
    undefined,
    processOptions(program),
  );
  let recoveredProcess: RecoveryProcess | undefined;
  try {
    const dispatch = await firstProcess.waitFor({
      kind: 'dispatched',
      path: program.path,
      attemptOrdinal: 1,
    });
    await firstProcess.kill();

    recoveredProcess = new RecoveryProcess(
      'recover',
      runId,
      scenario.intentId,
      undefined,
      processOptions(program),
    );
    const reconciliation = await recoveredProcess.waitFor({
      kind: 'reconciled',
      path: program.path,
      attemptOrdinal: 1,
    });
    assert.equal(reconciliation.attemptId, dispatch.attemptId);
    assert.equal(recoveredProcess.dispatched(program.path, 1), 0);

    if (program.completion !== undefined) {
      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: program.path,
        attemptOrdinal: program.completion.attempt,
      });
      recoveredProcess.complete(program.path, program.completion);
    }
    await recoveredProcess.waitFor({ kind: 'terminal', status: program.expectedStatus });
    await waitForObservation(recoveredProcess);
    assert.equal(recoveredProcess.count('reconciled', program.path), program.instructions.length);
    assertProgramObservation(program, firstProcess, recoveredProcess, dispatch);
  } finally {
    await firstProcess.kill();
    await recoveredProcess?.kill();
  }
};

const runHumanUnknownRecovery = async (scenario: RunScenario, runId: string): Promise<void> => {
  const path = 'main/publish';
  const firstProcess = new RecoveryProcess('start', runId, scenario.intentId, undefined, {
    input: null,
    instructions: [{ kind: 'outcomeUnknown' }],
  });
  let recoveredProcess: RecoveryProcess | undefined;
  try {
    const dispatch = await firstProcess.waitFor({ kind: 'dispatched', path, attemptOrdinal: 1 });
    assert(dispatch.attemptId !== undefined);
    await firstProcess.kill();

    recoveredProcess = new RecoveryProcess('recover', runId, scenario.intentId, undefined, {
      input: null,
      instructions: [{ kind: 'outcomeUnknown' }],
    });
    const reconciliation = await recoveredProcess.waitFor({
      kind: 'reconciled',
      path,
      attemptOrdinal: 1,
    });
    assert.equal(reconciliation.attemptId, dispatch.attemptId);
    await recoveredProcess.waitFor({ kind: 'checkpointed', path });
    recoveredProcess.resolveUnknownOutcome(dispatch.attemptId, 'release-manager', {
      kind: 'adoptSuccess',
      outcome: 'completed',
      output: { release: { kind: 'json', value: 'published' } },
    });
    const command = await recoveredProcess.waitFor({ kind: 'commandReceipt' });
    assert.equal(command.commandReceipt?.status, 'accepted');
    await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
    await waitForObservation(recoveredProcess);

    assert.equal(firstProcess.dispatched(path) + recoveredProcess.dispatched(path), 1);
    const details = recoveredProcess.reportedDetails();
    assert.deepStrictEqual(details.attempts, [
      { ordinal: 1, status: 'outcomeUnknown', recovery: { reconciliationRound: 1 } },
    ]);
    assert.deepStrictEqual(details.nodeStatuses, [{ path, status: 'completed' }]);
    assert.deepStrictEqual(details.runOutput, {
      release: { kind: 'json', value: 'published' },
    });
    assert(
      details.commands.some(
        (decision) =>
          decision.actorId === 'release-manager' &&
          decision.commandKind === 'resolveUnknownOutcome' &&
          decision.decision === 'accepted' &&
          decision.targetAttemptId === dispatch.attemptId &&
          decision.resolution?.kind === 'adoptSuccess' &&
          decision.resolution.outcome === 'completed',
      ),
    );
    assert(
      recoveredProcess
        .reportedEvents()
        .some(
          ({ type, data }) =>
            type === 'runCommand.accepted' &&
            typeof data === 'object' &&
            data !== null &&
            'attemptId' in data &&
            data.attemptId === dispatch.attemptId,
        ),
    );
  } finally {
    await firstProcess.kill();
    await recoveredProcess?.kill();
  }
};

export const runEffectRecoveryScenario = async (scenario: RunScenario): Promise<void> => {
  const runId = `rr06-${scenario.intentId}-${randomUUID()}`;
  if (scenario.intentId === 'rr-012') {
    await runHumanUnknownRecovery(scenario, runId);
    return;
  }
  const program = compileEffectRecoveryScenario(scenario);
  if (program.crashMoment === 'beforeEffect') {
    await runBeforeEffectRecovery(scenario, program, runId);
    return;
  }
  await runAmbiguousEffectRecovery(scenario, program, runId);
};
