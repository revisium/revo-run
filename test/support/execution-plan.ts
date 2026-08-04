import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';

import type { ExecutionPlan } from '../../src/index.js';

const taskCompilation = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'task',
    facts: [],
    nodes: [
      {
        kind: 'task',
        key: 'task',
        outcomes: { completed: 'done', failed: 'failed', cancelled: 'failed', skipped: 'failed' },
      },
      { kind: 'terminal', key: 'done', outcome: 'succeeded' },
      { kind: 'terminal', key: 'failed', outcome: 'failed' },
    ],
  }),
);
if (!taskCompilation.ok) {
  throw new Error('Task execution plan fixture is invalid.');
}

const candidateCompilation = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'review',
    facts: [],
    nodes: [
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
if (!candidateCompilation.ok) {
  throw new Error('Candidate execution plan fixture is invalid.');
}

const scriptCompilation = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'script',
    facts: [],
    nodes: [
      {
        kind: 'script',
        key: 'script',
        script: { id: 'script:test/example', version: 1 },
        input: null,
        outcomes: { completed: 'done', failed: 'failed', cancelled: 'failed', skipped: 'failed' },
      },
      { kind: 'terminal', key: 'done', outcome: 'succeeded' },
      { kind: 'terminal', key: 'failed', outcome: 'failed' },
    ],
  }),
);
if (!scriptCompilation.ok) {
  throw new Error('Script execution plan fixture is invalid.');
}

export const taskExecutionPlan: ExecutionPlan = taskCompilation.template;
export const candidateExecutionPlan: ExecutionPlan = candidateCompilation.template;
export const scriptExecutionPlan: ExecutionPlan = scriptCompilation.template;
