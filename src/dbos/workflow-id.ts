export const runWorkflowId = (runId: string): string => `rr:run:v1:${runId}`;

export const scopeWorkflowId = (scopeId: string): string => `rr:scope:v1:${scopeId}`;

export const scopeWorkflowV2Id = (scopeId: string): string => `rr:scope:v2:${scopeId}`;

export const commandWorkflowId = (commandId: string): string => `rr:command:v1:${commandId}`;
