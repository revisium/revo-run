import { canonicalizeJson } from '../policy/index.js';
import type { RunProgressionCommandReceipt } from './run-progression-command-receipt.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';

const same = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const isTaskOutcomeValid = (
  task: Extract<RunProgressionIntentStep, { readonly kind: 'complete_task' }>,
  semantic: Extract<
    RunProgressionCommandReceipt['semanticRequest'],
    { readonly kind: 'task_outcome' }
  >,
): boolean => {
  const { attempt, node } = task;
  if (semantic.outcome.kind === 'skipped') {
    return attempt === null && node.status === 'skipped' && node.terminalFault === null;
  }
  if (attempt?.status !== semantic.outcome.kind || node.status !== semantic.outcome.kind) {
    return false;
  }
  if (semantic.outcome.kind !== 'failed') {
    return attempt.fault === null && node.terminalFault === null;
  }
  return (
    attempt.fault?.code === semantic.outcome.faultCode &&
    attempt.fault.message === semantic.outcome.faultMessage &&
    same(node.terminalFault, attempt.fault)
  );
};

export const validateRunProgressionTaskOutcome = (input: {
  readonly receipt: RunProgressionCommandReceipt | undefined;
  readonly steps: readonly RunProgressionIntentStep[];
}): void => {
  const task = input.steps.find((step) => step.kind === 'complete_task');
  const semantic = input.receipt?.semanticRequest;
  if (task?.kind !== 'complete_task' || semantic?.kind !== 'task_outcome') return;
  if (!isTaskOutcomeValid(task, semantic)) {
    throw new TypeError('Run progression task semantic outcome is inconsistent.');
  }
};
