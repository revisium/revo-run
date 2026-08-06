import type { PipelineExecutionContext } from './interpreter-context.js';

export const runtimePath = (context: PipelineExecutionContext, nodePath: string): string =>
  nodePath.length === 0 ? context.runtimePath : `${context.runtimePath}/${nodePath}`;
