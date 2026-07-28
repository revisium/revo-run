import { canonicalizeJson } from '../policy/index.js';
import type { RunProgressionCommandReceipt } from './run-progression-command-receipt.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';

const same = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

export const validateRunProgressionTaskOutcome = (input: {
  readonly receipt: RunProgressionCommandReceipt | undefined;
  readonly steps: readonly RunProgressionIntentStep[];
}): void => {
  const task = input.steps.find((step) => step.kind === 'complete_task');
  const semantic = input.receipt?.semanticRequest;
  if (task?.kind !== 'complete_task' || semantic?.kind !== 'task_outcome') return;
  const { attempt, node } = task;
  const valid =
    semantic.outcome.kind === 'skipped'
      ? attempt === null && node.status === 'skipped' && node.terminalFault === null
      : attempt !== null &&
        attempt.status === semantic.outcome.kind &&
        node.status === semantic.outcome.kind &&
        (semantic.outcome.kind === 'failed'
          ? attempt.fault?.code === semantic.outcome.faultCode &&
            attempt.fault.message === semantic.outcome.faultMessage &&
            same(node.terminalFault, attempt.fault)
          : attempt.fault === null && node.terminalFault === null);
  if (!valid) {
    throw new TypeError('Run progression task semantic outcome is inconsistent.');
  }
};
