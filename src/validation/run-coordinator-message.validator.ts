import Schema from 'typebox/schema';

import {
  ExecutionReservationSchema,
  RunCoordinatorMessageSchema,
  type ExecutionReservation,
  type RunCoordinatorMessage,
} from '../contracts/workflow/run-coordinator-message.js';

const messageValidator = Schema.Compile(RunCoordinatorMessageSchema);
const reservationValidator = Schema.Compile(ExecutionReservationSchema);

export const parseRunCoordinatorMessage = (value: unknown): RunCoordinatorMessage => {
  if (!messageValidator.Check(value)) {
    throw new Error('Run coordinator received an invalid message.');
  }

  return value;
};

export const parseExecutionReservation = (value: unknown): ExecutionReservation => {
  if (!reservationValidator.Check(value)) {
    throw new Error('Run execution received an invalid reservation.');
  }

  return value;
};
