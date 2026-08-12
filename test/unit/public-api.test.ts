import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as publicApi from '../../src/index.js';
import type {
  AgentExecutorBinding,
  CreateRunManagerOptions,
  ExecutionBinding,
  ExecutionPlan,
  ListRunsInput,
  RunAttempt,
  RunDetails,
  RunError,
  RunEventCursor,
  RunEventPage,
  RunEventPageInput,
  RunEventSubscriptionInput,
  RunExecutorRequest,
  RunExecutorResult,
  RunManager,
  RunManagerErrorCode,
  RunEvent,
  RunId,
  RunNodeInstance,
  RunPage,
  RunResult,
  RunScope,
  RunSnapshot,
  RunStatus,
  RunSummary,
  ScriptExecutorBinding,
  StartRunInput,
  StartRunResult,
  WaitForTerminalInput,
} from '../../src/index.js';

describe('root-only public API', () => {
  it('exports only the approved runtime values', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'AgentExecutorBindingSchema',
      'ExecutionBindingSchema',
      'ExecutionPlanSchema',
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
    expectTypeOf<RunScope>().toBeObject();
    expectTypeOf<RunNodeInstance>().toBeObject();
    expectTypeOf<RunAttempt>().toBeObject();
    expectTypeOf<WaitForTerminalInput>().toBeObject();
  });
});
