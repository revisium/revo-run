import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import { MapNodeOutputSchema } from '../../src/contracts/pipeline/map-output.js';
import {
  PipelineActionSchema,
  PipelineDecisionInputSchema,
} from '../../src/contracts/pipeline/pipeline-action.js';
import { PipelineProgressSchema } from '../../src/contracts/pipeline/pipeline-progress.js';
import { StartRunInputSchema } from '../../src/contracts/run/start-run.js';
import { terminalExecutionPlan } from '../support/terminal-execution-plan.js';

const pipelineProgressValidator = Schema.Compile(PipelineProgressSchema);
const pipelineActionValidator = Schema.Compile(PipelineActionSchema);
const pipelineDecisionInputValidator = Schema.Compile(PipelineDecisionInputSchema);
const mapNodeOutputValidator = Schema.Compile(MapNodeOutputSchema);
const startRunInputValidator = Schema.Compile(StartRunInputSchema);

const emptyProgress = {
  nodes: [],
  consensusVotes: [],
  humanGateAnswers: [],
  reachedDeadlines: [],
};

describe('pipeline runtime contract validation', () => {
  it('validates durable pipeline progress', () => {
    expect(pipelineProgressValidator.Check(emptyProgress)).toBe(true);
    expect(
      pipelineProgressValidator.Check({
        ...emptyProgress,
        nodes: [{ nodePath: 'main/work', status: 'active', unexpected: true }],
      }),
    ).toBe(false);
  });

  it('validates pipeline decisions and their inputs', () => {
    const plan = terminalExecutionPlan();

    expect(
      pipelineDecisionInputValidator.Check({
        pipelines: plan.pipelines,
        pipelineId: plan.rootPipelineId,
        pipelineInstancePath: 'main',
        runInput: {},
        pipelineInput: {},
        progress: emptyProgress,
      }),
    ).toBe(true);
    expect(
      pipelineActionValidator.Check({
        kind: 'activateNodes',
        source: 'entry',
        nodePaths: ['main/work'],
      }),
    ).toBe(true);
    expect(
      pipelineActionValidator.Check({
        kind: 'activateNodes',
        source: 'entry',
        nodePaths: ['main/work'],
        unexpected: true,
      }),
    ).toBe(false);
  });

  it('validates bounded map summaries without arbitrary properties', () => {
    const output = {
      summary: {
        kind: 'json',
        value: {
          totalItems: 2,
          completedItems: 1,
          failedItems: 1,
          failures: [{ itemKey: 'repository-2', outcome: 'failed' }],
        },
      },
    };

    expect(mapNodeOutputValidator.Check(output)).toBe(true);
    expect(
      mapNodeOutputValidator.Check({
        ...output,
        summary: {
          ...output.summary,
          value: { ...output.summary.value, diagnostic: 'must not leak' },
        },
      }),
    ).toBe(false);
  });

  it('validates the public start-run command payload', () => {
    expect(
      startRunInputValidator.Check({
        runId: 'run_01',
        executionPlan: terminalExecutionPlan(),
        input: { projectId: 'project-1' },
      }),
    ).toBe(true);
  });
});
