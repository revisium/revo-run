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
