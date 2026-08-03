import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';
import { describe, expect, it, vi } from 'vitest';

import { interpretPipeline } from '../../src/lifecycle/pipeline-construction.js';

const compilation = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'prepare',
    facts: [],
    nodes: [
      {
        kind: 'task',
        key: 'prepare',
        outcomes: {
          completed: 'fanout',
          failed: 'failed',
          cancelled: 'failed',
          skipped: 'failed',
        },
      },
      {
        kind: 'fork',
        key: 'fanout',
        join: 'join',
        branches: [
          { name: 'one', entry: 'one', exit: 'one' },
          { name: 'two', entry: 'two', exit: 'two' },
        ],
      },
      {
        kind: 'task',
        key: 'one',
        outcomes: { completed: 'join', failed: 'join', cancelled: 'join', skipped: 'join' },
      },
      {
        kind: 'task',
        key: 'two',
        outcomes: { completed: 'join', failed: 'join', cancelled: 'join', skipped: 'join' },
      },
      {
        kind: 'join',
        key: 'join',
        fork: 'fanout',
        policy: { kind: 'all' },
        outcomes: { completed: 'review', rejected: 'failed', insufficient: 'failed' },
      },
      {
        kind: 'consensus',
        key: 'review',
        candidates: ['a', 'b'],
        policy: { kind: 'quorum', quorum: 2 },
        outcomes: { approved: 'done', rejected: 'failed', insufficient: 'failed', tied: 'failed' },
      },
      { kind: 'terminal', key: 'done', outcome: 'succeeded' },
      { kind: 'terminal', key: 'failed', outcome: 'failed' },
    ],
  }),
);

if (!compilation.ok) throw new Error('Test pipeline must compile.');

describe('pipeline interpreter', () => {
  it('executes task, fork, join, consensus, and terminal nodes', async () => {
    const taskNodes: string[] = [];
    const executeTask = vi.fn<(nodeKey: string) => Promise<'completed'>>(async (nodeKey) => {
      taskNodes.push(nodeKey);
      return 'completed' as const;
    });
    const executeCandidate = vi.fn<(nodeKey: string, candidate: string) => Promise<'approve'>>(
      async () => Promise.resolve('approve'),
    );

    await expect(
      interpretPipeline(compilation.pipeline, { executeCandidate, executeTask }),
    ).resolves.toEqual({ outcome: 'succeeded', terminalNode: 'done' });
    expect(taskNodes).toEqual(['prepare', 'one', 'two']);
    expect(executeCandidate).toHaveBeenCalledTimes(2);
  });

  it('maps executor failure to the failed terminal', async () => {
    await expect(
      interpretPipeline(compilation.pipeline, {
        executeCandidate: async () => 'approve',
        executeTask: async (nodeKey) => (nodeKey === 'prepare' ? 'failed' : 'completed'),
      }),
    ).resolves.toEqual({ outcome: 'failed', terminalNode: 'failed' });
  });
});
