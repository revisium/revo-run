import type { AttemptId, RunActivationId, RunNodeInstanceId } from '../spec/index.js';

export type RunCorrelation =
  | { readonly kind: 'run' }
  | {
      readonly kind: 'node';
      readonly nodeInstanceId: RunNodeInstanceId;
      readonly activationId: RunActivationId;
    }
  | {
      readonly kind: 'attempt';
      readonly nodeInstanceId: RunNodeInstanceId;
      readonly activationId: RunActivationId;
      readonly attemptId: AttemptId;
    };
