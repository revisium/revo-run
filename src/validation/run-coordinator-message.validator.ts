import Schema from 'typebox/schema';

import {
  ExecutionReservationSchema,
  RunCoordinatorMessageSchema,
  ScopeStartFenceReplySchema,
  type ExecutionReservation,
  type RunCoordinatorMessage,
  type ScopeStartFenceReply,
} from '../contracts/workflow/run-coordinator-message.js';

const messageValidator = Schema.Compile(RunCoordinatorMessageSchema);
const reservationValidator = Schema.Compile(ExecutionReservationSchema);
const admissionReplyValidator = Schema.Compile(ScopeStartFenceReplySchema);

export const parseRunCoordinatorMessage = (value: unknown): RunCoordinatorMessage => {
  if (!messageValidator.Check(value)) {
    throw new Error('Run coordinator message is invalid.');
  }
  return value;
};

export const parseExecutionReservation = (value: unknown): ExecutionReservation => {
  if (!reservationValidator.Check(value)) {
    throw new Error('Execution reservation is invalid.');
  }
  return value;
};

export const parseScopeStartFenceReply = (value: unknown): ScopeStartFenceReply => {
  if (!admissionReplyValidator.Check(value)) {
    throw new Error('Scope start fence reply is invalid.');
  }
  return value;
};
