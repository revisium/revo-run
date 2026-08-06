export const runWorkflowName = 'revo-run.run.v1';
export const runEventStreamName = 'revo-run.events';

const nodeExecutionStepPrefix = 'execute-node:';

export const nodeExecutionStepName = (path: string): string => `${nodeExecutionStepPrefix}${path}`;

export const isNodeExecutionStepName = (name: string): boolean =>
  name.startsWith(nodeExecutionStepPrefix);
