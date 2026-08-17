import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import { RunEventSchema } from '../../src/contracts/run/run-event.js';
import {
  CommandDispatchWorkflowInputSchema,
  CommandDispatchWorkflowResultSchema,
  RunCommandDecisionSchema,
  ScopeDirectiveSchema,
  ScopeSettlementAcknowledgementSchema,
  UnknownResolutionDirectiveSchema,
} from '../../src/contracts/workflow/run-command-workflow.js';
import { RunCoordinatorMessageSchema } from '../../src/contracts/workflow/run-coordinator-message.js';
import {
  AnswerGateInputSchema,
  CancelRunInputSchema,
  CommandIdSchema,
  ResolveUnknownOutcomeInputSchema,
  RunCommandReceiptSchema,
} from '../../src/index.js';
import matrixJson from '../fixtures/rr07/commands-cancellation-context-matrix.json' with { type: 'json' };
import goldenJson from '../fixtures/rr07/commands-cancellation-golden-vectors.json' with { type: 'json' };

interface Vector {
  readonly id: string;
  readonly valid: boolean;
  readonly value: unknown;
}

interface GoldenFixture {
  readonly metadata: Metadata;
  readonly commandIds: readonly Vector[];
  readonly decisions: readonly Vector[];
  readonly dispatchInputs: readonly Vector[];
  readonly dispatchResults: readonly Vector[];
  readonly fixedMarkFailedCode: string;
  readonly managerErrors: readonly string[];
  readonly publicInputs: readonly (Vector & { readonly schema: string })[];
  readonly receipts: readonly Vector[];
  readonly rejectionReasons: readonly string[];
  readonly scopeDirectives: readonly Vector[];
  readonly scopeSettlementAcknowledgements: readonly Vector[];
  readonly storedEvents: readonly Vector[];
  readonly unknownDirectives: readonly Vector[];
}

interface Metadata {
  readonly artifactVersion: number;
  readonly cloudRevision: string;
  readonly contract: string;
  readonly sourceRevision: string;
}

interface MatrixFixture {
  readonly metadata: Metadata;
  readonly axes: Readonly<Record<string, readonly string[]>>;
  readonly proofCases: readonly Readonly<Record<string, string>>[];
  readonly stopProofs: readonly string[];
}

const fixturePath = (name: string): URL => new URL(`../fixtures/rr07/${name}`, import.meta.url);
const bytes = (name: string): Buffer => readFileSync(fixturePath(name));
const digest = (name: string): string => createHash('sha256').update(bytes(name)).digest('hex');

const goldenName = 'commands-cancellation-golden-vectors.json';
const matrixName = 'commands-cancellation-context-matrix.json';
const golden: GoldenFixture = goldenJson;
const matrix: MatrixFixture = matrixJson;
const metadata: Metadata = {
  contract: 'rr-07-commands-cancellation',
  artifactVersion: 1,
  sourceRevision: '69e321c540cf3aaf7cd6d39b7797bc6ef1fcea5b',
  cloudRevision: 'R2x6tCvlAf6saYkSIS9U9',
};

const checkVectors = (
  vectors: readonly Vector[],
  validator: { Check(value: unknown): boolean },
): void => {
  for (const vector of vectors) {
    expect(validator.Check(vector.value)).toBe(vector.valid);
  }
};

describe('assurance artifacts', () => {
  it('pins exact checked-in fixture bytes and contract metadata', () => {
    expect(digest(goldenName)).toBe(
      '8b83ce04714df2f32fe78d82f5d41ac9f6dd45b993b7098d430e18f953e726ad',
    );
    expect(digest(matrixName)).toBe(
      'b8e6c23591e85c13dc0271f39c0f08b531abe9f4206c648dfbab207a6a305f7d',
    );
    expect(golden.metadata).toStrictEqual(metadata);
    expect(matrix.metadata).toStrictEqual(metadata);
  });

  it('validates public, durable, observation, and redaction vectors', () => {
    const cancel = Schema.Compile(CancelRunInputSchema);
    const resolve = Schema.Compile(ResolveUnknownOutcomeInputSchema);
    const answerGate = Schema.Compile(AnswerGateInputSchema);
    for (const vector of golden.publicInputs) {
      const validator =
        vector.schema === 'cancel'
          ? cancel
          : vector.schema === 'resolve'
            ? resolve
            : vector.schema === 'answerGate'
              ? answerGate
              : undefined;
      if (validator === undefined) {
        throw new Error(`Unknown assurance schema ${vector.schema}.`);
      }
      expect(validator.Check(vector.value)).toBe(vector.valid);
    }
    checkVectors(golden.commandIds, Schema.Compile(CommandIdSchema));
    checkVectors(golden.receipts, Schema.Compile(RunCommandReceiptSchema));
    checkVectors(golden.dispatchInputs, Schema.Compile(CommandDispatchWorkflowInputSchema));
    checkVectors(golden.dispatchResults, Schema.Compile(CommandDispatchWorkflowResultSchema));
    checkVectors(golden.scopeDirectives, Schema.Compile(ScopeDirectiveSchema));
    checkVectors(
      golden.scopeSettlementAcknowledgements,
      Schema.Compile(ScopeSettlementAcknowledgementSchema),
    );
    checkVectors(golden.unknownDirectives, Schema.Compile(UnknownResolutionDirectiveSchema));
    checkVectors(golden.decisions, Schema.Compile(RunCommandDecisionSchema));
    checkVectors(golden.storedEvents, Schema.Compile(RunEventSchema));
    expect(JSON.stringify(golden.decisions.filter(({ valid }) => valid))).not.toContain(
      'must-not-appear',
    );
  });

  it('pins every rejection, manager error, and fixed failure code', () => {
    expect(golden.rejectionReasons).toStrictEqual([
      'run_already_terminal',
      'run_cancellation_requested',
      'unknown_outcome_not_pending',
      'unknown_outcome_already_resolved',
      'unknown_outcome_retry_not_permitted',
      'gate_already_resolved',
    ]);
    expect(golden.managerErrors).toStrictEqual([
      'invalid_cancel_run_input',
      'invalid_resolve_unknown_outcome_input',
      'invalid_answer_gate_input',
      'run_command_failed',
      'manager_not_started',
      'run_not_found',
      'manager_stop_failed',
    ]);
    expect(golden.fixedMarkFailedCode).toBe('unknown_outcome_resolved_failed');
  });

  it('rejects cross-command metadata, excess fields, and foreign scope lineage', () => {
    const decisions = Schema.Compile(RunCommandDecisionSchema);
    const events = Schema.Compile(RunEventSchema);
    const messages = Schema.Compile(RunCoordinatorMessageSchema);
    const cancelMetadata = {
      commandId: 'cmd_00000000-0000-4000-8000-000000000001',
      commandKind: 'cancelRun',
      actorId: 'operator',
    };

    expect(
      decisions.Check({
        ...cancelMetadata,
        decision: 'accepted',
        attemptId: `at1_${'a'.repeat(43)}`,
        resolutionKind: 'retry',
      }),
    ).toBe(false);
    expect(
      decisions.Check({
        commandId: cancelMetadata.commandId,
        commandKind: 'answerGate',
        decision: 'accepted',
      }),
    ).toBe(false);
    expect(
      decisions.Check({
        ...cancelMetadata,
        decision: 'rejected',
        reason: 'unknown_outcome_not_pending',
      }),
    ).toBe(false);
    expect(
      decisions.Check({
        commandId: cancelMetadata.commandId,
        commandKind: 'resolveUnknownOutcome',
        actorId: 'operator',
        attemptId: `at1_${'a'.repeat(43)}`,
        resolutionKind: 'markFailed',
        decision: 'rejected',
        reason: 'gate_already_resolved',
      }),
    ).toBe(false);
    expect(
      decisions.Check({
        commandId: cancelMetadata.commandId,
        commandKind: 'answerGate',
        decision: 'rejected',
        reason: 'unknown_outcome_retry_not_permitted',
      }),
    ).toBe(false);
    expect(
      events.Check({
        cursor: 'run-1:1',
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'runCommand.accepted',
        data: { ...cancelMetadata, outcome: 'impossible' },
      }),
    ).toBe(false);
    for (const data of [
      {
        commandId: cancelMetadata.commandId,
        commandKind: 'answerGate',
      },
      {
        ...cancelMetadata,
        reason: 'unknown_outcome_not_pending',
      },
      {
        commandId: cancelMetadata.commandId,
        commandKind: 'resolveUnknownOutcome',
        actorId: 'operator',
        attemptId: `at1_${'a'.repeat(43)}`,
        resolutionKind: 'markFailed',
        reason: 'gate_already_resolved',
      },
      {
        commandId: cancelMetadata.commandId,
        commandKind: 'answerGate',
        reason: 'unknown_outcome_retry_not_permitted',
      },
    ]) {
      expect(
        events.Check({
          cursor: 'run-1:2',
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'reason' in data ? 'runCommand.rejected' : 'runCommand.accepted',
          data,
        }),
      ).toBe(false);
    }
    expect(
      messages.Check({
        kind: 'scopeReady',
        workflowId: `rr:scope:sc1_${'a'.repeat(43)}`,
        parentWorkflowId: 'rr:scope:foreign',
      }),
    ).toBe(false);
  });

  it('pins every context axis and supplies a proof witness for each value', () => {
    const expectedAxes = {
      commandKind: [
        'cancelRun',
        'resolve.adoptSuccess',
        'resolve.markFailed',
        'resolve.retry',
        'answerGate.accepted',
        'answerGate.actorNotEligible',
        'answerGate.actorAlreadyAnswered',
        'answerGate.gateAlreadyResolved',
        'answerGate.invalidAnswer',
      ],
      managerState: ['notStarted', 'started', 'stopping', 'stopped', 'restarted'],
      runState: [
        'missing',
        'admittedPending',
        'running',
        'succeeded',
        'failed',
        'cancelled',
        'foreignWorkflow',
      ],
      delivery: ['first', 'sameInternalIdReplay', 'distinctSemanticRepeat', 'conflictingSameId'],
      resolutionTarget: [
        'pendingUnknown',
        'notPending',
        'alreadyResolved',
        'cancellationRequested',
        'retryNotPermitted',
      ],
      executionLocus: [
        'beforeReadiness',
        'beforeDispatch',
        'providerRunning',
        'retryBackoff',
        'parallelChild',
      ],
      processBoundary: ['sameProcess', 'restartBeforeDecision', 'restartAfterDecision'],
      providerSettlement: ['cooperativeAbort', 'lateSuccess', 'lateFailure'],
      stopCase: [
        'noActiveRuns',
        'drainsBeforeDeadline',
        'drainExpires',
        'shutdownExpires',
        'shutdownFailureAfterPartialCleanup',
        'relaunch',
      ],
      historyEffect: [
        'acceptedLiveEvent',
        'rejectedLiveEvent',
        'eventBudgetDispatchFailure',
        'noTerminalAppend',
        'noForeignAppend',
        'streamClosesWithoutFinalCancelledEvent',
      ],
    } as const;
    expect(matrix.axes).toStrictEqual(expectedAxes);

    for (const [axis, values] of Object.entries(expectedAxes)) {
      const witnessed =
        axis === 'stopCase'
          ? new Set(matrix.stopProofs)
          : new Set(
              matrix.proofCases.flatMap((proof) =>
                proof[axis] === undefined ? [] : [proof[axis]],
              ),
            );
      expect(witnessed).toEqual(new Set(values));
    }
  });
});
