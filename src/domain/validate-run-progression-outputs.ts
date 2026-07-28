import { canonicalizeJson } from '../policy/index.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionState } from './run-progression-state.js';

export const validateRunProgressionOutputs = (input: {
  readonly runId: string;
  readonly state: RunProgressionState;
  readonly steps: readonly RunProgressionIntentStep[];
  readonly transactionNow: number;
}): void => {
  const receipt = input.state.commandReceipts.at(-1);
  const task = input.steps.find((step) => step.kind === 'complete_task');
  if (task?.kind === 'complete_task') {
    const succeeded =
      receipt?.semanticRequest.kind === 'task_outcome' &&
      receipt.semanticRequest.outcome.kind === 'succeeded';
    if (!succeeded) {
      if (receipt?.hostAttachment.kind !== 'none' || task.outputs.length !== 0) {
        throw new TypeError('Run progression task output attachment is invalid.');
      }
    } else {
      if (
        receipt?.hostAttachment.kind !== 'task_outputs' ||
        task.attempt === null ||
        task.outputs.length !== receipt.hostAttachment.outputs.length
      ) {
        throw new TypeError('Run progression task output attachment is invalid.');
      }
      task.outputs.forEach((output, index) => {
        const attached =
          receipt.hostAttachment.kind === 'task_outputs'
            ? receipt.hostAttachment.outputs[index]
            : undefined;
        if (
          attached === undefined ||
          output.runId !== input.runId ||
          output.createdAt !== input.transactionNow ||
          output.name !== attached.name ||
          canonicalizeJson(output.payload) !== canonicalizeJson(attached.payload) ||
          output.correlation.kind !== 'attempt' ||
          output.correlation.attemptId !== task.attempt?.id ||
          output.correlation.nodeInstanceId !== task.node.id ||
          output.correlation.activationId !== task.node.activationId
        ) {
          throw new TypeError('Run progression task output is invalid.');
        }
      });
    }
  }
  const gate = input.steps.find((step) => step.kind === 'resolve_gate');
  if (gate?.kind === 'resolve_gate') {
    if (
      receipt?.hostAttachment.kind !== 'gate_answer_output' ||
      gate.output.runId !== input.runId ||
      gate.output.createdAt !== input.transactionNow ||
      gate.output.name !== 'answer' ||
      canonicalizeJson(gate.output.payload) !==
        canonicalizeJson(receipt.hostAttachment.answerOutput) ||
      gate.output.correlation.kind !== 'node' ||
      gate.output.correlation.nodeInstanceId !== gate.node.id ||
      gate.output.correlation.activationId !== gate.node.activationId
    ) {
      throw new TypeError('Run progression gate answer output is invalid.');
    }
  }
};
