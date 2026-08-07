export const runWorkflowName = 'revo-run.run.v1';
export const runExecutionWorkflowName = 'revo-run.execution.v1';
export const parallelBranchWorkflowName = 'revo-run.parallel-branch.v1';
export const runEventStreamName = 'revo-run.events';
export const runCoordinatorMessageTopic = 'revo-run.coordinator';
export const runCoordinatorReplyTopic = 'revo-run.coordinator.reply';

const nodeExecutionStepPrefix = 'execute-node:';

export const nodeExecutionStepName = (path: string): string => `${nodeExecutionStepPrefix}${path}`;

export const isNodeExecutionStepName = (name: string): boolean =>
  name.startsWith(nodeExecutionStepPrefix);
