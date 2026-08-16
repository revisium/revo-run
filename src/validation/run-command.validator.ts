import Schema from 'typebox/schema';

import {
  AnswerGateInputSchema,
  CancelRunInputSchema,
  ResolveUnknownOutcomeInputSchema,
  type AnswerGateInput,
  type CancelRunInput,
  type ResolveUnknownOutcomeInput,
} from '../contracts/run/run-command.js';

const cancelRunValidator = Schema.Compile(CancelRunInputSchema);
const resolveUnknownOutcomeValidator = Schema.Compile(ResolveUnknownOutcomeInputSchema);
const answerGateValidator = Schema.Compile(AnswerGateInputSchema);

export const isCancelRunInput = (value: unknown): value is CancelRunInput =>
  cancelRunValidator.Check(value);

export const isResolveUnknownOutcomeInput = (value: unknown): value is ResolveUnknownOutcomeInput =>
  resolveUnknownOutcomeValidator.Check(value);

export const isAnswerGateInput = (value: unknown): value is AnswerGateInput =>
  answerGateValidator.Check(value);
