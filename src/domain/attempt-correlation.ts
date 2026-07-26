import type { RunCorrelation } from './run-correlation.js';

export type AttemptCorrelation = Extract<RunCorrelation, { readonly kind: 'attempt' }>;
