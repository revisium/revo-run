import { PipelineSourcePackageSchema } from '@revisium/revo-pipeline';
import {
  ScriptEventSchema as OwningScriptEventSchema,
  type ScriptEvent as OwningScriptEvent,
} from '@revisium/revo-scripts';
import { Type, type Static, type TSchema } from 'typebox';

import { isJsonObject, JsonValueSchema } from './json.js';
import { RunProfileSchema } from './run-profile.js';

const closed = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const maximumSafeInteger = Number.MAX_SAFE_INTEGER;
const nonEmpty = (maximum = 256) => Type.String({ minLength: 1, maxLength: maximum });
const positiveSafeInteger = Type.Integer({ minimum: 1, maximum: maximumSafeInteger });
const nonNegativeSafeInteger = Type.Integer({ minimum: 0, maximum: maximumSafeInteger });
const jsonPointer = Type.String({
  maxLength: 512,
  pattern: '^(?:/(?:[^~/]|~[01])*)*$',
});
const jsonObject = Type.Record(Type.String(), JsonValueSchema);

export const isUtcTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const timestamp = Type.Refine(
  Type.String({ pattern: String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` }),
  isUtcTimestamp,
);

const isBoundedDetails = (value: unknown): boolean => {
  if (!isJsonObject(value)) {
    return false;
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 65_536;
};

const boundedJsonObject = Type.Refine(jsonObject, isBoundedDetails);

const isAbortSignal = (value: unknown): value is AbortSignal =>
  typeof value === 'object' &&
  value !== null &&
  'aborted' in value &&
  typeof value.aborted === 'boolean' &&
  'addEventListener' in value &&
  typeof value.addEventListener === 'function' &&
  'removeEventListener' in value &&
  typeof value.removeEventListener === 'function';

const abortSignal = Type.Refine(Type.Any(), isAbortSignal);

export const RunIdSchema = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9._-]{0,127}$' });
export const CreateRunInputSchema = closed({
  runId: RunIdSchema,
  pipeline: PipelineSourcePackageSchema,
  profile: RunProfileSchema,
  input: JsonValueSchema,
});
export type CreateRunInput = Static<typeof CreateRunInputSchema>;
export const CreateRunResultSchema = closed({ runId: RunIdSchema });
export type CreateRunResult = Static<typeof CreateRunResultSchema>;
export const RunStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('cancelling'),
  Type.Literal('recovery_required'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);
export type RunStatus = Static<typeof RunStatusSchema>;

export const RunPublicFailureSchema = closed({
  code: nonEmpty(),
  message: nonEmpty(4_096),
  path: Type.Union([jsonPointer, Type.Null()]),
  details: Type.Union([boundedJsonObject, Type.Null()]),
});
export type RunPublicFailure = Static<typeof RunPublicFailureSchema>;

export const RunTerminalSchema = Type.Union([
  closed({ kind: Type.Literal('succeeded'), outcome: nonEmpty(), output: JsonValueSchema }),
  closed({ kind: Type.Literal('failed'), error: RunPublicFailureSchema }),
  closed({ kind: Type.Literal('cancelled'), reasonCode: nonEmpty() }),
]);
export type RunTerminal = Static<typeof RunTerminalSchema>;

const pendingSnapshot = (status: 'pending' | 'running' | 'cancelling' | 'recovery_required') =>
  closed({
    schemaVersion: Type.Literal('run-snapshot/v1'),
    runId: RunIdSchema,
    status: Type.Literal(status),
    createdAt: timestamp,
    updatedAt: timestamp,
    terminal: Type.Null(),
  });
const terminalSnapshot = (
  status: 'succeeded' | 'failed' | 'cancelled',
  kind: RunTerminal['kind'],
) =>
  closed({
    schemaVersion: Type.Literal('run-snapshot/v1'),
    runId: RunIdSchema,
    status: Type.Literal(status),
    createdAt: timestamp,
    updatedAt: timestamp,
    terminal: Type.Intersect([RunTerminalSchema, Type.Object({ kind: Type.Literal(kind) })]),
  });

export const RunSnapshotSchema = Type.Union([
  pendingSnapshot('pending'),
  pendingSnapshot('running'),
  pendingSnapshot('cancelling'),
  pendingSnapshot('recovery_required'),
  terminalSnapshot('succeeded', 'succeeded'),
  terminalSnapshot('failed', 'failed'),
  terminalSnapshot('cancelled', 'cancelled'),
]);
export type RunSnapshot = Static<typeof RunSnapshotSchema>;

export const RunOperationStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('recovery_required'),
]);

export const RunOperationSnapshotSchema = closed({
  operationId: nonEmpty(),
  kind: Type.Union([
    Type.Literal('agent'),
    Type.Literal('script'),
    Type.Literal('durationWait'),
    Type.Literal('signalWait'),
    Type.Literal('humanGate'),
  ]),
  status: RunOperationStatusSchema,
  openedAt: timestamp,
  updatedAt: timestamp,
});
export type RunOperationSnapshot = Static<typeof RunOperationSnapshotSchema>;

export const RunActivitySnapshotSchema = Type.Union([
  closed({
    operationId: nonEmpty(),
    kind: Type.Union([Type.Literal('agent'), Type.Literal('script')]),
    requirementKey: nonEmpty(),
    status: Type.Literal('succeeded'),
    output: JsonValueSchema,
    failure: Type.Null(),
  }),
  closed({
    operationId: nonEmpty(),
    kind: Type.Union([Type.Literal('agent'), Type.Literal('script')]),
    requirementKey: nonEmpty(),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('running'),
      Type.Literal('cancelled'),
      Type.Literal('recovery_required'),
    ]),
    output: Type.Null(),
    failure: Type.Null(),
  }),
  closed({
    operationId: nonEmpty(),
    kind: Type.Union([Type.Literal('agent'), Type.Literal('script')]),
    requirementKey: nonEmpty(),
    status: Type.Literal('failed'),
    output: Type.Null(),
    failure: RunPublicFailureSchema,
  }),
]);
export type RunActivitySnapshot = Static<typeof RunActivitySnapshotSchema>;

export const RunAttemptSnapshotSchema = Type.Union([
  closed({
    attemptId: nonEmpty(),
    operationId: nonEmpty(),
    executor: Type.Union([Type.Literal('agent'), Type.Literal('script')]),
    ordinal: positiveSafeInteger,
    status: Type.Union([Type.Literal('pending'), Type.Literal('running'), Type.Literal('unknown')]),
    startedAt: Type.Union([timestamp, Type.Null()]),
    finishedAt: Type.Null(),
    failure: Type.Null(),
  }),
  closed({
    attemptId: nonEmpty(),
    operationId: nonEmpty(),
    executor: Type.Union([Type.Literal('agent'), Type.Literal('script')]),
    ordinal: positiveSafeInteger,
    status: Type.Literal('succeeded'),
    startedAt: timestamp,
    finishedAt: timestamp,
    failure: Type.Null(),
  }),
  closed({
    attemptId: nonEmpty(),
    operationId: nonEmpty(),
    executor: Type.Union([Type.Literal('agent'), Type.Literal('script')]),
    ordinal: positiveSafeInteger,
    status: Type.Literal('cancelled'),
    startedAt: timestamp,
    finishedAt: timestamp,
    failure: Type.Null(),
  }),
  closed({
    attemptId: nonEmpty(),
    operationId: nonEmpty(),
    executor: Type.Union([Type.Literal('agent'), Type.Literal('script')]),
    ordinal: positiveSafeInteger,
    status: Type.Union([Type.Literal('failed'), Type.Literal('timed_out')]),
    startedAt: timestamp,
    finishedAt: timestamp,
    failure: RunPublicFailureSchema,
  }),
]);
export type RunAttemptSnapshot = Static<typeof RunAttemptSnapshotSchema>;

export const RunWaitSnapshotSchema = closed({
  waitId: nonEmpty(),
  operationId: nonEmpty(),
  kind: Type.Union([Type.Literal('duration'), Type.Literal('signal')]),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('completed'),
    Type.Literal('cancelled'),
  ]),
  signal: Type.Union([nonEmpty(), Type.Null()]),
  openedAt: timestamp,
  deadlineAt: Type.Union([timestamp, Type.Null()]),
});
export type RunWaitSnapshot = Static<typeof RunWaitSnapshotSchema>;

const gateProperties = {
  gateId: nonEmpty(),
  operationId: nonEmpty(),
  subject: nonEmpty(4_096),
  answers: Type.Array(nonEmpty(), { minItems: 1, uniqueItems: true }),
  openedAt: timestamp,
  deadlineAt: Type.Union([timestamp, Type.Null()]),
};
export const RunGateSnapshotSchema = Type.Union([
  closed({ ...gateProperties, status: Type.Literal('pending'), resolution: Type.Null() }),
  closed({
    ...gateProperties,
    status: Type.Literal('answered'),
    resolution: closed({
      kind: Type.Literal('answer'),
      answer: nonEmpty(),
      actorId: nonEmpty(),
      payload: Type.Union([JsonValueSchema, Type.Null()]),
    }),
  }),
  closed({
    ...gateProperties,
    status: Type.Literal('deadline'),
    resolution: closed({ kind: Type.Literal('deadline') }),
  }),
  closed({
    ...gateProperties,
    status: Type.Literal('cancelled'),
    resolution: closed({ kind: Type.Literal('cancelled') }),
  }),
]);
export type RunGateSnapshot = Static<typeof RunGateSnapshotSchema>;

export const RunRecoveryRequiredSnapshotSchema = closed({
  operationId: nonEmpty(),
  attemptId: nonEmpty(),
  executor: Type.Union([Type.Literal('agent'), Type.Literal('script')]),
  reasonCode: Type.Union([Type.Literal('outcome_unknown'), Type.Literal('reconciliation_failed')]),
  since: timestamp,
});
export type RunRecoveryRequiredSnapshot = Static<typeof RunRecoveryRequiredSnapshotSchema>;

const isRunEventCursor = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const match = /^([A-Za-z][A-Za-z0-9._-]{0,127}):([1-9]\d*)$/.exec(value);
  return match !== null && Number.isSafeInteger(Number(match[2]));
};

export const RunEventCursorSchema = Type.Refine(
  Type.String({ pattern: String.raw`^[A-Za-z][A-Za-z0-9._-]{0,127}:[1-9]\d*$` }),
  isRunEventCursor,
);

const detailsSchema = (status: RunStatus, terminal: TSchema) =>
  closed({
    schemaVersion: Type.Literal('run-details/v1'),
    runId: RunIdSchema,
    status: Type.Literal(status),
    createdAt: timestamp,
    updatedAt: timestamp,
    terminal,
    activities: Type.Array(RunActivitySnapshotSchema),
    operations: Type.Array(RunOperationSnapshotSchema),
    attempts: Type.Array(RunAttemptSnapshotSchema),
    waits: Type.Array(RunWaitSnapshotSchema),
    gates: Type.Array(RunGateSnapshotSchema),
    recovery: Type.Array(RunRecoveryRequiredSnapshotSchema),
  });

export const RunDetailsSchema = Type.Union([
  detailsSchema('pending', Type.Null()),
  detailsSchema('running', Type.Null()),
  detailsSchema('cancelling', Type.Null()),
  detailsSchema('recovery_required', Type.Null()),
  detailsSchema(
    'succeeded',
    Type.Intersect([RunTerminalSchema, Type.Object({ kind: Type.Literal('succeeded') })]),
  ),
  detailsSchema(
    'failed',
    Type.Intersect([RunTerminalSchema, Type.Object({ kind: Type.Literal('failed') })]),
  ),
  detailsSchema(
    'cancelled',
    Type.Intersect([RunTerminalSchema, Type.Object({ kind: Type.Literal('cancelled') })]),
  ),
]);
export type RunDetails = Static<typeof RunDetailsSchema>;

// Script events are owned by revo-scripts. Reusing its exported JSON Schema
// keeps the public event envelope aligned with SC1's validation and bounds.
export const ScriptEventSchema = Type.Unsafe<OwningScriptEvent>(
  OwningScriptEventSchema.toJsonSchema(),
);
export type ScriptEvent = OwningScriptEvent;

export const RunEventPayloadSchema = Type.Union([
  closed({ type: Type.Literal('run.admitted') }),
  closed({ type: Type.Literal('run.started') }),
  closed({ type: Type.Literal('run.status_changed'), from: RunStatusSchema, to: RunStatusSchema }),
  closed({ type: Type.Literal('run.terminal'), terminal: RunTerminalSchema }),
  closed({ type: Type.Literal('activity.operation_created'), activity: RunActivitySnapshotSchema }),
  closed({
    type: Type.Literal('activity.operation_finished'),
    activity: RunActivitySnapshotSchema,
  }),
  closed({ type: Type.Literal('activity.attempt_started'), attempt: RunAttemptSnapshotSchema }),
  closed({ type: Type.Literal('activity.attempt_finished'), attempt: RunAttemptSnapshotSchema }),
  closed({
    type: Type.Literal('activity.recovery_required'),
    recovery: RunRecoveryRequiredSnapshotSchema,
  }),
  closed({
    type: Type.Literal('script.event'),
    operationId: nonEmpty(),
    attemptId: nonEmpty(),
    emissionOrdinal: positiveSafeInteger,
    event: ScriptEventSchema,
  }),
  closed({ type: Type.Literal('wait.opened'), wait: RunWaitSnapshotSchema }),
  closed({ type: Type.Literal('wait.resolved'), wait: RunWaitSnapshotSchema }),
  closed({ type: Type.Literal('gate.opened'), gate: RunGateSnapshotSchema }),
  closed({ type: Type.Literal('gate.resolved'), gate: RunGateSnapshotSchema }),
  closed({ type: Type.Literal('run.cancellation_requested'), actorId: nonEmpty() }),
  closed({ type: Type.Literal('run.cancellation_acknowledged'), operationId: nonEmpty() }),
]);
export type RunEventPayload = Static<typeof RunEventPayloadSchema>;

export const RunEventSchema = closed({
  schemaVersion: Type.Literal('run-event/v1'),
  runId: RunIdSchema,
  sequence: positiveSafeInteger,
  cursor: RunEventCursorSchema,
  occurredAt: timestamp,
  payload: RunEventPayloadSchema,
});
export type RunEvent = Static<typeof RunEventSchema>;

export const RunPageSchema = closed({
  items: Type.Array(RunSnapshotSchema),
  nextOffset: Type.Union([nonNegativeSafeInteger, Type.Null()]),
});
export const RunEventPageInputSchema = closed({
  after: Type.Optional(RunEventCursorSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const RunEventSubscriptionInputSchema = closed({
  after: Type.Optional(RunEventCursorSchema),
});
export const RunEventPageSchema = closed({
  items: Type.Array(RunEventSchema),
  nextCursor: Type.Union([RunEventCursorSchema, Type.Null()]),
  hasMore: Type.Boolean(),
});
export const ListRunsFilterSchema = closed({
  statuses: Type.Optional(Type.Array(RunStatusSchema, { uniqueItems: true })),
  createdAtFrom: Type.Optional(timestamp),
  createdAtTo: Type.Optional(timestamp),
  offset: Type.Optional(nonNegativeSafeInteger),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const CancelRunInputSchema = closed({ runId: RunIdSchema, actorId: nonEmpty() });
export const SendSignalInputSchema = closed({
  runId: RunIdSchema,
  waitId: nonEmpty(),
  signal: nonEmpty(),
  payload: Type.Optional(JsonValueSchema),
  actorId: nonEmpty(),
});
export const AnswerGateInputSchema = closed({
  runId: RunIdSchema,
  gateId: nonEmpty(),
  answer: nonEmpty(),
  payload: Type.Optional(JsonValueSchema),
  actorId: nonEmpty(),
  actorGroups: Type.Optional(Type.Array(nonEmpty(), { uniqueItems: true })),
});
export const WaitForTerminalInputSchema = closed({
  timeoutMs: Type.Optional(positiveSafeInteger),
  signal: Type.Optional(abortSignal),
});
