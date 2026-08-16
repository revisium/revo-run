import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import { ConsensusVoteSchema } from '../../src/contracts/pipeline/consensus-vote.js';
import { MapNodeOutputSchema } from '../../src/contracts/pipeline/map-output.js';
import { StartRunInputSchema } from '../../src/contracts/run/start-run.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const consensusVoteValidator = Schema.Compile(ConsensusVoteSchema);
const mapNodeOutputValidator = Schema.Compile(MapNodeOutputSchema);
const startRunInputValidator = Schema.Compile(StartRunInputSchema);

describe('pipeline runtime contract validation', () => {
  it('validates the executor-facing consensus vote payload', () => {
    const vote = {
      nodePath: 'main/review',
      participantId: 'architecture',
      vote: 'approve',
      executionId: 'execution-architecture-1',
    };

    expect(consensusVoteValidator.Check(vote)).toBe(true);
    expect(consensusVoteValidator.Check({ ...vote, unexpected: true })).toBe(false);
    expect(consensusVoteValidator.Check({ ...vote, vote: 'tie' })).toBe(false);
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
