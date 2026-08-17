export const runWorkflowIdPrefix = 'rr:run:';
export const scopeWorkflowIdPrefix = 'rr:scope:';
const commandWorkflowIdPrefix = 'rr:command:';

export const runWorkflowId = (runId: string): string => `${runWorkflowIdPrefix}${runId}`;

export const scopeWorkflowId = (scopeId: string): string => `${scopeWorkflowIdPrefix}${scopeId}`;

export const commandWorkflowId = (commandId: string): string =>
  `${commandWorkflowIdPrefix}${commandId}`;

export const isRunWorkflowId = (workflowId: string): boolean =>
  workflowId.startsWith(runWorkflowIdPrefix);

export const isScopeWorkflowId = (workflowId: string): boolean =>
  workflowId.startsWith(scopeWorkflowIdPrefix);

export const scopeIdFromWorkflowId = (workflowId: string): string =>
  workflowId.slice(scopeWorkflowIdPrefix.length);
