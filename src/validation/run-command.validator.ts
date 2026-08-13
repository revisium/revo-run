import Schema from 'typebox/schema';

import {
  CancelRunInputSchema,
  ResolveUnknownOutcomeInputSchema,
  type CancelRunInput,
  type ResolveUnknownOutcomeInput,
} from '../contracts/run/run-command.js';

const cancelRunValidator = Schema.Compile(CancelRunInputSchema);
const resolveUnknownOutcomeValidator = Schema.Compile(ResolveUnknownOutcomeInputSchema);

export const isCancelRunInput = (value: unknown): value is CancelRunInput =>
  cancelRunValidator.Check(value);

export const isResolveUnknownOutcomeInput = (value: unknown): value is ResolveUnknownOutcomeInput =>
  resolveUnknownOutcomeValidator.Check(value);
