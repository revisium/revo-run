export type RunCorrelation =
  | { readonly kind: 'run' }
  | {
      readonly kind: 'node';
      readonly nodeInstanceId: string;
      readonly activationId: string;
    }
  | {
      readonly kind: 'attempt';
      readonly nodeInstanceId: string;
      readonly activationId: string;
      readonly attemptId: string;
    };
