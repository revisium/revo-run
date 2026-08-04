import type { CreateRunManagerOptions } from '../types.js';

interface ActiveWorkflowContext {
  readonly dependencies: CreateRunManagerOptions;
  readonly owner: symbol;
}

export interface WorkflowContextBinding {
  dispose(): void;
}

let activeContext: ActiveWorkflowContext | undefined;

export const bindWorkflowContext = (
  dependencies: CreateRunManagerOptions,
): WorkflowContextBinding => {
  const owner = Symbol('workflow-context');
  activeContext = { dependencies, owner };

  return {
    dispose: () => {
      if (activeContext?.owner === owner) activeContext = undefined;
    },
  };
};

export const getWorkflowDependencies = (): CreateRunManagerOptions => {
  if (!activeContext) throw new Error('Run manager workflow context is not active.');
  return activeContext.dependencies;
};
