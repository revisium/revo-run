import { describe, expect, it } from 'vitest';

import { ExecutionPlanValidator } from '../../src/validation/execution-plan.validator.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

describe('execution plan validation', () => {
  it('accepts a complete supported execution plan', () => {
    expect(ExecutionPlanValidator.Check(terminalExecutionPlan())).toBe(true);
  });

  it('rejects additional contract properties', () => {
    expect(
      ExecutionPlanValidator.Check({
        ...terminalExecutionPlan(),
        unexpected: true,
      }),
    ).toBe(false);
  });

  it('rejects malformed nested pipeline nodes', () => {
    const plan = terminalExecutionPlan();

    expect(
      ExecutionPlanValidator.Check({
        ...plan,
        pipelines: {
          main: {
            root: {
              ...plan.pipelines['main']?.root,
              unexpected: true,
            },
          },
        },
      }),
    ).toBe(false);
  });

  it('rejects identifiers outside the contract grammar', () => {
    expect(
      ExecutionPlanValidator.Check({
        ...terminalExecutionPlan(),
        rootPipelineId: 'invalid/pipeline',
      }),
    ).toBe(false);
  });

  it('rejects invalid pipeline-relative node paths', () => {
    expect(
      ExecutionPlanValidator.Check({
        ...terminalExecutionPlan(),
        bindings: [
          {
            kind: 'script',
            target: { pipelineId: 'main', nodePath: 'invalid//path' },
            script: { id: 'example', version: '1.0.0' },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects secret references in terminal output mappings', () => {
    const plan = terminalExecutionPlan();

    expect(
      ExecutionPlanValidator.Check({
        ...plan,
        pipelines: {
          main: {
            root: {
              kind: 'end',
              status: 'succeeded',
              outcome: 'completed',
              output: {
                credential: {
                  kind: 'secret',
                  reference: { name: 'production-token' },
                },
              },
            },
          },
        },
      }),
    ).toBe(false);
  });
});
