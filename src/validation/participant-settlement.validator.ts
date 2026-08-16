import Schema from 'typebox/schema';

import {
  ParticipantSettlementSchema,
  type ParticipantSettlement,
} from '../contracts/workflow/participant-settlement.js';

const validator = Schema.Compile(ParticipantSettlementSchema);

export const parseParticipantSettlement = (value: unknown): ParticipantSettlement => {
  if (!validator.Check(value)) {
    throw new Error('Participant settlement is invalid.');
  }
  return value;
};
