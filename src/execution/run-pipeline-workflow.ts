import { decidePipeline } from '@revisium/revo-pipeline';
import type { PipelineFacts } from '@revisium/revo-pipeline';

import type { RunResult } from '../run/run.js';
import type { RunWorkflowInput } from './run-workflow-input.js';

const emptyFacts: PipelineFacts = {
  candidateVerdicts: [],
  gateResolutions: [],
  nodes: [],
  values: [],
};

export const runPipelineWorkflow = async ({
  executionPlan,
}: RunWorkflowInput): Promise<RunResult> => {
  const activation = decidePipeline(executionPlan.pipeline, emptyFacts);
  if (activation.kind !== 'activate') {
    throw new Error('Execution plan does not have a single terminal entry.');
  }

  const [nodeKey, ...otherNodeKeys] = activation.nodeKeys;
  if (nodeKey === undefined || otherNodeKeys.length > 0) {
    throw new Error('Execution plan does not have a single terminal entry.');
  }

  const decision = decidePipeline(executionPlan.pipeline, {
    ...emptyFacts,
    nodes: [{ key: nodeKey, state: 'enabled' }],
  });
  if (decision.kind !== 'terminal') {
    throw new Error('Execution plan is not terminal-only.');
  }

  return { outcome: decision.outcome };
};
