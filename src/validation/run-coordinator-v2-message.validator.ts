import Schema from 'typebox/schema';

import {
  ExecutionReservationV2Schema,
  RunCoordinatorV2MessageSchema,
  type ExecutionReservationV2,
  type RunCoordinatorV2Message,
} from '../contracts/workflow/run-coordinator-v2-message.js';

const messageValidator = Schema.Compile(RunCoordinatorV2MessageSchema);
const reservationValidator = Schema.Compile(ExecutionReservationV2Schema);

export const parseRunCoordinatorV2Message = (value: unknown): RunCoordinatorV2Message => {
  if (!messageValidator.Check(value)) {
    throw new Error('Run coordinator v2 message is invalid.');
  }
  return value;
};

export const parseExecutionReservationV2 = (value: unknown): ExecutionReservationV2 => {
  if (!reservationValidator.Check(value)) {
    throw new Error('Execution reservation v2 is invalid.');
  }
  return value;
};
