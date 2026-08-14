import type { PipelineExecutionContext } from './interpreter-context.js';

export const runtimePath = (context: PipelineExecutionContext, nodePath: string): string => {
  const prefix = context.nodePathPrefix;
  if (prefix === undefined || prefix.length === 0) {
    return nodePath.length === 0 ? context.runtimePath : `${context.runtimePath}/${nodePath}`;
  }
  if (nodePath === prefix) {
    return context.runtimePath;
  }
  const prefixWithSeparator = `${prefix}/`;
  if (!nodePath.startsWith(prefixWithSeparator)) {
    throw new Error('Runtime node path is outside its authored prefix.');
  }
  return `${context.runtimePath}/${nodePath.slice(prefixWithSeparator.length)}`;
};
