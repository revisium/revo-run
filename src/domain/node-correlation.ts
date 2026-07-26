import type { RunCorrelation } from './run-correlation.js';

export type NodeCorrelation = Extract<RunCorrelation, { readonly kind: 'node' }>;
