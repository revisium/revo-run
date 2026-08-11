import Type from 'typebox';
import Schema from 'typebox/schema';

import type { DeepReadonly } from '../contracts/deep-readonly.js';

const DbosStepRecordSchema = Type.Object(
  {
    functionID: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    name: Type.String({ minLength: 1 }),
    output: Type.Unknown(),
    error: Type.Union([Type.Null(), Type.Unknown()]),
    childWorkflowID: Type.Union([Type.Null(), Type.String({ minLength: 1 })]),
    startedAtEpochMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    completedAtEpochMs: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  },
  { additionalProperties: false },
);

const DbosStepRecordValidator = Schema.Compile(DbosStepRecordSchema);

export type DbosStepRecord = DeepReadonly<Type.Static<typeof DbosStepRecordSchema>>;

export const parseDbosStepRecord = (value: unknown): DbosStepRecord => {
  if (!DbosStepRecordValidator.Check(value)) {
    throw new Error('DBOS step record is invalid.');
  }
  if (
    value.startedAtEpochMs !== undefined &&
    value.completedAtEpochMs !== undefined &&
    value.completedAtEpochMs < value.startedAtEpochMs
  ) {
    throw new Error('DBOS step timestamps are inverted.');
  }
  return value;
};
