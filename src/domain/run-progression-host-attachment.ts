import type { ExecutorOutput, RunOutputPayload } from '../spec/index.js';

export type RunProgressionHostAttachment =
  | { readonly kind: 'none' }
  | { readonly kind: 'task_outputs'; readonly outputs: readonly ExecutorOutput[] }
  | { readonly kind: 'gate_answer_output'; readonly answerOutput: RunOutputPayload };
