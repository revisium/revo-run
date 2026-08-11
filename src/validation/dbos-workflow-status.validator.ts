import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';
import Type from 'typebox';
import Schema from 'typebox/schema';

const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });

const DbosWorkflowStatusSchema = Type.Object(
  {
    workflowID: Type.String(),
    status: Type.String(),
    workflowName: Type.String(),
    workflowClassName: Type.String(),
    workflowConfigName: Type.Optional(Type.String()),
    queueName: Type.Optional(Type.String()),
    authenticatedUser: Type.Optional(Type.String()),
    assumedRole: Type.Optional(Type.String()),
    authenticatedRoles: Type.Optional(Type.Array(Type.String())),
    input: Type.Optional(Type.Array(Type.Unknown())),
    output: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.Unknown()),
    executorId: Type.Optional(Type.String()),
    applicationVersion: Type.Optional(Type.String()),
    createdAt: NonNegativeIntegerSchema,
    updatedAt: Type.Optional(NonNegativeIntegerSchema),
    timeoutMS: Type.Optional(NonNegativeIntegerSchema),
    deadlineEpochMS: Type.Optional(NonNegativeIntegerSchema),
    deduplicationID: Type.Optional(Type.String()),
    priority: Type.Integer(),
    queuePartitionKey: Type.Optional(Type.String()),
    dequeuedAt: Type.Optional(NonNegativeIntegerSchema),
    delayUntilEpochMS: Type.Optional(NonNegativeIntegerSchema),
    completedAt: Type.Optional(NonNegativeIntegerSchema),
    forkedFrom: Type.Optional(Type.String()),
    wasForkedFrom: Type.Optional(Type.Boolean()),
    parentWorkflowID: Type.Optional(Type.String()),
    attributes: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    scheduleName: Type.Optional(Type.String()),
    applicationID: Type.String(),
    request: Type.Optional(Type.Object({}, { additionalProperties: true })),
    recoveryAttempts: Type.Optional(NonNegativeIntegerSchema),
  },
  { additionalProperties: false },
);

const validator = Schema.Compile(DbosWorkflowStatusSchema);

export const parseDbosWorkflowStatus = (value: unknown): WorkflowStatus => {
  if (!validator.Check(value)) {
    throw new Error('DBOS workflow status envelope is invalid.');
  }

  return value;
};
