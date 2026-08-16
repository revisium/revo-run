import Schema from 'typebox/schema';

import {
  ConsensusParticipantWorkflowArgumentsSchema,
  ConsensusParticipantWorkflowInputSchema,
  type ConsensusParticipantWorkflowInput,
} from '../contracts/workflow/consensus-participant-workflow-input.js';

const validator = Schema.Compile(ConsensusParticipantWorkflowInputSchema);
const argumentsValidator = Schema.Compile(ConsensusParticipantWorkflowArgumentsSchema);

const invalidInput = (): Error => new Error('Consensus participant workflow input is invalid.');

export const parseConsensusParticipantWorkflowInput = (
  value: unknown,
): ConsensusParticipantWorkflowInput => {
  if (!validator.Check(value) || value.node.kind !== 'task') {
    throw invalidInput();
  }
  return value;
};

export const ConsensusParticipantWorkflowArgumentsParser = {
  parse(value: unknown): unknown {
    if (!argumentsValidator.Check(value)) {
      throw invalidInput();
    }
    const input = Array.isArray(value) ? value[0] : undefined;
    if (input === undefined || typeof input !== 'object' || input === null) {
      throw invalidInput();
    }
    if (!('node' in input) || (input.node as { kind?: unknown }).kind !== 'task') {
      throw invalidInput();
    }
    return value;
  },
};
