export const runWorkflowId = (runId: string): string => `revo-run:${runId}`;

export const operationWorkflowId = (operationId: string): string =>
  `revo-run.operation:${operationId}`;
