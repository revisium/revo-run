import type { ParallelBranchResult } from '../../contracts/workflow/parallel-branch-result.js';
import type { MapItemBodyResult } from '../map/map-item-runner.js';
import type { RepeatIterationBodyResult } from '../repeat/repeat-iteration-runner.js';
import type { PipelineExecutionContext } from './interpreter-context.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';

export const toBranchScopeResult = (
  result: NodeExecutionResult,
  context: PipelineExecutionContext,
  branchKey: string,
  inheritedOutputPaths: ReadonlySet<string>,
): ParallelBranchResult => {
  if (result.kind === 'continued' || result.provenance === 'authoredEnd') {
    return {
      kind: 'continued',
      key: branchKey,
      outcome: result.kind === 'continued' ? result.outcome : result.result.outcome,
      outputs: [...context.outputs].filter(([path]) => !inheritedOutputPaths.has(path)),
    };
  }
  return { kind: 'terminal', key: branchKey, result: result.result };
};

export const toRepeatScopeResult = (result: NodeExecutionResult): RepeatIterationBodyResult => {
  if (result.kind === 'continued') {
    return {
      kind: 'continued',
      outcome: result.outcome,
      ...(result.output === undefined ? {} : { output: result.output }),
    };
  }
  if (result.provenance === 'authoredEnd') {
    throw new Error('Repeat iteration body produced an authored terminal End.');
  }
  return { kind: 'terminal', result: result.result };
};

export const toMapItemScopeResult = (result: NodeExecutionResult): MapItemBodyResult => {
  if (result.kind === 'continued') {
    return {
      kind: 'continued',
      outcome: result.outcome,
      ...(result.output === undefined ? {} : { output: result.output }),
    };
  }
  return result.provenance === 'authoredEnd'
    ? { kind: 'authoredEnd', result: result.result }
    : { kind: 'terminal', result: result.result };
};
