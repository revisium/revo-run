import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as publicApi from '../../src/index.js';
import type {
  AgentExecutorBinding,
  AnswerGateInput,
  ConsensusVote,
  CancelRunInput,
  CommandId,
  CreateRunManagerOptions,
  ExecutionBinding,
  ExecutionPlan,
  ListRunsInput,
  MapExecutionObservation,
  RunAttempt,
  RunCommandReceipt,
  RunCommandRejectionReason,
  RunCommandDetails,
  RunConsensus,
  RunConsensusAcceptedVote,
  RunDetails,
  RunError,
  RunEventCursor,
  RunEventPage,
  RunEventPageInput,
  RunEventSubscriptionInput,
  RunExecutorRequest,
  RunExecutorResult,
  RunGate,
  RunManager,
  RunManagerErrorCode,
  RunEvent,
  RunId,
  RunNodeInstance,
  RunPage,
  RunResult,
  RunScope,
  ResolveUnknownOutcomeInput,
  RunSnapshot,
  RunStatus,
  RunSummary,
  ScriptExecutorBinding,
  SkippedMapItem,
  StartRunInput,
  StartRunResult,
  WaitForTerminalInput,
} from '../../src/index.js';

describe('root-only public API', () => {
  it('exports only the approved runtime values', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'AgentExecutorBindingSchema',
      'AnswerGateInputSchema',
      'CancelRunInputSchema',
      'CommandIdSchema',
      'ConsensusVoteSchema',
      'ExecutionBindingSchema',
      'ExecutionPlanSchema',
      'MapExecutionObservationSchema',
      'ParallelJoinObservationSchema',
      'ResolveUnknownOutcomeInputSchema',
      'RunCommandReceiptSchema',
      'RunErrorSchema',
      'RunEventCursorSchema',
      'RunEventPageInputSchema',
      'RunEventPageSchema',
      'RunEventSchema',
      'RunEventSubscriptionInputSchema',
      'RunExecutorReconciliationResultSchema',
      'RunExecutorRequestSchema',
      'RunExecutorResultSchema',
      'RunIdSchema',
      'RunManagerError',
      'RunManagerErrorCodeSchema',
      'RunResultSchema',
      'RunStatusSchema',
      'ScriptExecutorBindingSchema',
      'SkippedMapItemSchema',
      'SkippedParallelBranchSchema',
      'StartRunInputSchema',
      'StartRunResultSchema',
      'createRunManager',
    ]);
  });

  it('declares only the root package entrypoint', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );

    expect(manifest).toEqual(
      expect.objectContaining({
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        },
      }),
    );
  });

  it('keeps the supported type surface available from the package root', () => {
    expectTypeOf<CreateRunManagerOptions>().toBeObject();
    expectTypeOf<RunManager>().toBeObject();
    expectTypeOf<ExecutionPlan>().toBeObject();
    expectTypeOf<ExecutionBinding>().toMatchTypeOf<AgentExecutorBinding | ScriptExecutorBinding>();
    expectTypeOf<StartRunInput>().toBeObject();
    expectTypeOf<StartRunResult>().toBeObject();
    expectTypeOf<RunExecutorRequest>().toBeObject();
    expectTypeOf<RunExecutorResult>().toMatchTypeOf<{ readonly kind: string }>();
    expectTypeOf<RunManagerErrorCode>().toBeString();
    expectTypeOf<RunEvent>().toBeObject();
    expectTypeOf<RunEventCursor>().toBeString();
    expectTypeOf<RunEventPageInput>().toBeObject();
    expectTypeOf<RunEventPage>().toBeObject();
    expectTypeOf<RunEventSubscriptionInput>().toBeObject();
    expectTypeOf<RunId>().toBeString();
    expectTypeOf<ListRunsInput>().toBeObject();
    expectTypeOf<RunPage>().toBeObject();
    expectTypeOf<RunStatus>().toBeString();
    expectTypeOf<RunError>().toBeObject();
    expectTypeOf<RunResult>().toBeObject();
    expectTypeOf<RunSummary>().toBeObject();
    expectTypeOf<RunSnapshot>().toBeObject();
    expectTypeOf<RunDetails>().toBeObject();
    expectTypeOf<MapExecutionObservation>().toMatchTypeOf<{ readonly outcome: string }>();
    expectTypeOf<SkippedMapItem>().toBeObject();
    expectTypeOf<RunScope>().toBeObject();
    expectTypeOf<RunNodeInstance>().toBeObject();
    expectTypeOf<RunAttempt>().toBeObject();
    expectTypeOf<CancelRunInput>().toBeObject();
    expectTypeOf<ResolveUnknownOutcomeInput>().toBeObject();
    expectTypeOf<AnswerGateInput>().toBeObject();
    expectTypeOf<RunGate>().toMatchTypeOf<{ readonly status: string }>();
    expectTypeOf<RunConsensus>().toMatchTypeOf<{ readonly status: string }>();
    expectTypeOf<RunConsensusAcceptedVote>().toMatchTypeOf<{ readonly vote: string }>();
    expectTypeOf<RunCommandRejectionReason>().toBeString();
    expectTypeOf<ConsensusVote>().toMatchTypeOf<{ readonly vote: string }>();
    expectTypeOf<RunCommandReceipt>().toMatchTypeOf<{ readonly commandId: string }>();
    expectTypeOf<RunCommandDetails>().toMatchTypeOf<{ readonly commandId: string }>();
    expectTypeOf<CommandId>().toBeString();
    expectTypeOf<WaitForTerminalInput>().toBeObject();
  });

  it.each([
    ['createRunManager', "import { createRunManager } from '@revisium/revo-run';"],
    ['start', '- lifecycle: `start`, `stop`'],
    ['stop', '- lifecycle: `start`, `stop`'],
    ['startRun', '- start: `startRun`'],
    [
      'getRun',
      '- observe: `getRun`, `listRuns`, `getRunDetails`, `getRunEvents`, `subscribeRunEvents`,',
    ],
    [
      'listRuns',
      '- observe: `getRun`, `listRuns`, `getRunDetails`, `getRunEvents`, `subscribeRunEvents`,',
    ],
    [
      'getRunDetails',
      '- observe: `getRun`, `listRuns`, `getRunDetails`, `getRunEvents`, `subscribeRunEvents`,',
    ],
    [
      'getRunEvents',
      '- observe: `getRun`, `listRuns`, `getRunDetails`, `getRunEvents`, `subscribeRunEvents`,',
    ],
    [
      'subscribeRunEvents',
      '- observe: `getRun`, `listRuns`, `getRunDetails`, `getRunEvents`, `subscribeRunEvents`,',
    ],
    ['waitForTerminal', '  `waitForTerminal`'],
    ['cancelRun', '- control: `cancelRun`, `answerGate`, `resolveUnknownOutcome`'],
    ['answerGate', '- control: `cancelRun`, `answerGate`, `resolveUnknownOutcome`'],
    ['resolveUnknownOutcome', '- control: `cancelRun`, `answerGate`, `resolveUnknownOutcome`'],
  ] as const)('documents %s on the package root README', (_name, needle) => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme.includes(needle)).toBe(true);
  });
});
