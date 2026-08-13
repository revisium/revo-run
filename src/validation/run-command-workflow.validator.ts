import Schema from 'typebox/schema';

import {
  CommandDispatchWorkflowArgumentsSchema,
  CommandDispatchWorkflowInputSchema,
  CommandDispatchWorkflowResultSchema,
  RunCommandDecisionSchema,
  ScopeDirectiveSchema,
  ScopeSettlementAcknowledgementSchema,
  UnknownResolutionDirectiveSchema,
  type CommandDispatchWorkflowInput,
  type CommandDispatchWorkflowResult,
  type RunCommandDecision,
  type ScopeDirective,
  type ScopeSettlementAcknowledgement,
  type UnknownResolutionDirective,
} from '../contracts/workflow/run-command-workflow.js';

const inputValidator = Schema.Compile(CommandDispatchWorkflowInputSchema);
const argumentsValidator = Schema.Compile(CommandDispatchWorkflowArgumentsSchema);
const resultValidator = Schema.Compile(CommandDispatchWorkflowResultSchema);
const decisionValidator = Schema.Compile(RunCommandDecisionSchema);
const scopeDirectiveValidator = Schema.Compile(ScopeDirectiveSchema);
const scopeSettlementAcknowledgementValidator = Schema.Compile(
  ScopeSettlementAcknowledgementSchema,
);
const unknownResolutionValidator = Schema.Compile(UnknownResolutionDirectiveSchema);

const parse = <Value>(
  value: unknown,
  validator: { Check(value: unknown): value is Value },
  message: string,
): Value => {
  if (!validator.Check(value)) {
    throw new Error(message);
  }
  return value;
};

export const parseCommandDispatchInput = (value: unknown): CommandDispatchWorkflowInput =>
  parse(value, inputValidator, 'Command dispatch workflow input is invalid.');

export const parseCommandDispatchResult = (value: unknown): CommandDispatchWorkflowResult =>
  parse(value, resultValidator, 'Command dispatch workflow result is invalid.');

export const parseRunCommandDecision = (value: unknown): RunCommandDecision =>
  parse(value, decisionValidator, 'Run command decision is invalid.');

export const parseScopeDirective = (value: unknown): ScopeDirective =>
  parse(value, scopeDirectiveValidator, 'Scope directive is invalid.');

export const parseScopeSettlementAcknowledgement = (
  value: unknown,
): ScopeSettlementAcknowledgement =>
  parse(
    value,
    scopeSettlementAcknowledgementValidator,
    'Scope settlement acknowledgement is invalid.',
  );

export const parseUnknownResolutionDirective = (value: unknown): UnknownResolutionDirective =>
  parse(value, unknownResolutionValidator, 'Unknown outcome resolution is invalid.');

export const CommandDispatchWorkflowArgumentsParser = {
  parse(value: unknown): unknown {
    return parse(value, argumentsValidator, 'Command dispatch workflow input is invalid.');
  },
};
