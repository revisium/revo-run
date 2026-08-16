import { randomUUID } from 'node:crypto';

import Schema from 'typebox/schema';
import { describe, expect, it, vi } from 'vitest';

import {
  CancelRunInputSchema,
  CommandIdSchema,
  ResolveUnknownOutcomeInputSchema,
  RunCommandReceiptSchema,
} from '../../src/index.js';
import type {
  AnswerGateInput,
  CancelRunInput,
  ExecutionPlan,
  JsonValue,
  ResolveUnknownOutcomeInput,
  RunCommandReceipt,
} from '../../src/index.js';
import { RunManager } from '../../src/manager/run-manager.js';

const commandId = `cmd_${randomUUID()}`;
const attemptId = `at1_${'A'.repeat(43)}`;
const cancelValidator = Schema.Compile(CancelRunInputSchema);
const resolutionValidator = Schema.Compile(ResolveUnknownOutcomeInputSchema);
const receiptValidator = Schema.Compile(RunCommandReceiptSchema);
const commandIdValidator = Schema.Compile(CommandIdSchema);

const runtime = () => ({
  cancelRun: vi.fn<(input: CancelRunInput) => Promise<RunCommandReceipt>>(async () => ({
    status: 'accepted',
    commandId,
  })),
  getRun: vi.fn<(runId: string) => Promise<undefined>>(async () => undefined),
  getRunDetails: vi.fn<(runId: string) => Promise<undefined>>(async () => undefined),
  getRunEvents: vi.fn<(runId: string, input: object) => Promise<{ hasMore: false; items: [] }>>(
    async () => ({ hasMore: false, items: [] }),
  ),
  listRuns: vi.fn<(input: object) => Promise<{ items: [] }>>(async () => ({ items: [] })),
  resolveUnknownOutcome: vi.fn<(input: ResolveUnknownOutcomeInput) => Promise<RunCommandReceipt>>(
    async () => ({ status: 'accepted', commandId }),
  ),
  answerGate: vi.fn<(input: AnswerGateInput) => Promise<RunCommandReceipt>>(async () => ({
    status: 'accepted',
    commandId,
  })),
  start: vi.fn<() => Promise<void>>(async () => undefined),
  startRun: vi.fn<(runId: string, plan: ExecutionPlan, input: JsonValue) => Promise<void>>(
    async () => undefined,
  ),
  stop: vi.fn<() => Promise<void>>(async () => undefined),
  subscribeRunEvents: vi.fn<(runId: string, input: object) => AsyncGenerator<never>>(
    async function* () {},
  ),
  waitForTerminal: vi.fn<(runId: string, input: object, signal: AbortSignal) => Promise<never>>(
    async () => {
      throw new Error('not used');
    },
  ),
});

describe('RR-07 public run-command contract', () => {
  it('accepts only manager-generated v4 command IDs', () => {
    const generatedId = randomUUID();
    const nonV4Id = `${generatedId.slice(0, 14)}5${generatedId.slice(15)}`;
    expect(commandIdValidator.Check(commandId)).toBe(true);
    expect(commandIdValidator.Check(`cmd_${nonV4Id}`)).toBe(false);
    expect(commandIdValidator.Check(randomUUID())).toBe(false);
    expect(commandIdValidator.Check('cmd_00000000-0000-4000-8000-000000000000-extra')).toBe(false);
  });

  it('keeps cancel input closed and free of caller command IDs', () => {
    expect(cancelValidator.Check({ runId: 'run-1', actorId: 'operator' })).toBe(true);
    expect(cancelValidator.Check({ runId: 'run-1', actorId: 'operator', commandId })).toBe(false);
  });

  it.each([
    {
      runId: 'run-1',
      attemptId,
      actorId: 'operator',
      resolution: { kind: 'adoptSuccess', outcome: 'published', output: {} },
    },
    {
      runId: 'run-1',
      attemptId,
      actorId: 'operator',
      resolution: { kind: 'markFailed' },
    },
    {
      runId: 'run-1',
      attemptId,
      actorId: 'operator',
      resolution: { kind: 'retry' },
    },
  ])('accepts the closed $resolution.kind resolution variant', (input) => {
    expect(resolutionValidator.Check(input)).toBe(true);
  });

  it('rejects arbitrary adopted output and public failure details', () => {
    const base = {
      runId: 'run-1',
      attemptId,
      actorId: 'operator',
    };
    expect(
      resolutionValidator.Check({
        ...base,
        resolution: { kind: 'adoptSuccess', outcome: 'published', output: { result: 1 } },
      }),
    ).toBe(false);
    expect(
      resolutionValidator.Check({
        ...base,
        resolution: { kind: 'markFailed', errorCode: 'caller_chosen' },
      }),
    ).toBe(false);
  });

  it('accepts every closed receipt outcome', () => {
    expect(receiptValidator.Check({ status: 'accepted', commandId })).toBe(true);
    expect(
      receiptValidator.Check({
        status: 'rejected',
        commandId,
        reason: 'unknown_outcome_retry_not_permitted',
      }),
    ).toBe(true);
    expect(receiptValidator.Check({ status: 'accepted', commandId, reason: 'extra' })).toBe(false);
  });

  it('validates public commands before dispatching them', async () => {
    const adapter = runtime();
    const manager = new RunManager(adapter);
    await manager.start();

    const malformedCancel = { runId: 'run-1', actorId: 'operator', commandId };
    await expect(manager.cancelRun(malformedCancel)).rejects.toMatchObject({
      code: 'invalid_cancel_run_input',
    });
    await expect(
      manager.resolveUnknownOutcome({
        runId: 'run-1',
        attemptId: 'bad',
        actorId: 'operator',
        resolution: { kind: 'retry' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_resolve_unknown_outcome_input' });
    await expect(
      manager.answerGate({
        runId: 'run-1',
        gateInstanceId: 'main/approval',
        answer: 'approved',
        actorId: 'alice',
        actorGroups: [],
        commandId: 'gate-answer-1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_answer_gate_input' });
    expect(adapter.cancelRun).not.toHaveBeenCalled();
    expect(adapter.resolveUnknownOutcome).not.toHaveBeenCalled();
    expect(adapter.answerGate).not.toHaveBeenCalled();
  });
});
