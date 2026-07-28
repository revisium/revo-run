import type { RunProgressionValueFact } from './run-progression-value-fact.js';

export type RunProgressionValueRecord = RunProgressionValueFact & {
  readonly source:
    | { readonly kind: 'init' }
    | { readonly kind: 'task_outcome'; readonly nodeKey: string }
    | { readonly kind: 'human_gate_resolution'; readonly nodeKey: string };
};
