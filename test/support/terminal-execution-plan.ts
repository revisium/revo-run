import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';

import type { ExecutionPlan } from '../../src/index.js';

export const terminalExecutionPlan = (): ExecutionPlan => {
  const compilation = compilePipeline(
    definePipeline({
      schemaVersion: 1,
      entry: 'finish',
      facts: [],
      nodes: [{ kind: 'terminal', key: 'finish', outcome: 'succeeded' }],
    }),
  );
  if (!compilation.ok) {
    throw new Error('Terminal pipeline compilation failed.');
  }

  return compilation.template;
};

export const taskExecutionPlan = (): ExecutionPlan => {
  const compilation = compilePipeline(
    definePipeline({
      schemaVersion: 1,
      entry: 'work',
      facts: [],
      nodes: [
        {
          kind: 'task',
          key: 'work',
          outcomes: {
            cancelled: 'finish',
            completed: 'finish',
            failed: 'finish',
            skipped: 'finish',
          },
        },
        { kind: 'terminal', key: 'finish', outcome: 'succeeded' },
      ],
    }),
  );
  if (!compilation.ok) {
    throw new Error('Task pipeline compilation failed.');
  }

  return compilation.template;
};
