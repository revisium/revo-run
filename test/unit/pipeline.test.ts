import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';
import { describe, expect, it, vi } from 'vitest';

import { childWorkflowId, interpretPipeline } from '../../src/pipeline/interpret-pipeline.js';
import { createPendingSnapshot } from '../../src/snapshot/create-snapshot.js';

const compilation = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'fork',
    facts: [],
    nodes: [
      {
        kind: 'fork',
        key: 'fork',
        join: 'join',
        branches: [
          { name: 'a', entry: 'a', exit: 'a' },
          { name: 'b', entry: 'b', exit: 'b' },
        ],
      },
      {
        kind: 'task',
        key: 'a',
        outcomes: { completed: 'join', failed: 'join', cancelled: 'join', skipped: 'join' },
      },
      {
        kind: 'task',
        key: 'b',
        outcomes: { completed: 'join', failed: 'join', cancelled: 'join', skipped: 'join' },
      },
      {
        kind: 'join',
        key: 'join',
        fork: 'fork',
        policy: { kind: 'all' },
        outcomes: { completed: 'review', rejected: 'failed', insufficient: 'failed' },
      },
      {
        kind: 'consensus',
        key: 'review',
        candidates: ['x', 'y'],
        policy: { kind: 'quorum', quorum: 2 },
        outcomes: { approved: 'done', rejected: 'failed', insufficient: 'failed', tied: 'failed' },
      },
      { kind: 'terminal', key: 'done', outcome: 'succeeded' },
      { kind: 'terminal', key: 'failed', outcome: 'failed' },
    ],
  }),
);
if (!compilation.ok) throw new Error('fixture compilation failed');

describe('pipeline continuation', () => {
  it('runs fork, join, consensus, and terminal semantics', async () => {
    const started = new Set<string>();
    let release = (): void => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executeTask = vi.fn<(nodeKey: string) => Promise<'completed'>>(async (nodeKey) => {
      started.add(nodeKey);
      if (started.size === 2) release();
      await barrier;
      return 'completed';
    });
    const executeCandidate = vi.fn<() => Promise<'approve'>>(async () => 'approve');
    await expect(
      interpretPipeline(compilation.pipeline, { executeTask, executeCandidate }),
    ).resolves.toEqual({ outcome: 'succeeded', terminalNode: 'done' });
    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(started).toEqual(new Set(['a', 'b']));
    expect(executeCandidate).toHaveBeenCalledTimes(2);
  });

  it('frames deterministic child IDs without tuple collisions', () => {
    expect(childWorkflowId('a', 'bc')).not.toBe(childWorkflowId('ab', 'c'));
    expect(childWorkflowId('a', 'bc')).toBe(childWorkflowId('a', 'bc'));
    expect(childWorkflowId('x'.repeat(100_000))).toHaveLength(79);
  });

  it('rejects invalid compiled plans', async () => {
    await expect(
      interpretPipeline(null, {
        executeTask: async () => 'completed',
        executeCandidate: async () => 'approve',
      }),
    ).rejects.toThrow('invalid compiled pipeline');
  });

  it('defensively copies arrays and primitive values', () => {
    const input = [{ value: 1 }, true];
    const snapshot = createPendingSnapshot('id', { id: 'p', revision: '1', digest: 'd' }, input);
    input[0] = false;
    expect(snapshot.input).toEqual([{ value: 1 }, true]);
    expect(Object.isFrozen(snapshot.input)).toBe(true);
  });
});
