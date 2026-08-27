import type { PipelineDiagnostic } from '@revisium/revo-pipeline';
import { Type, type Static, type TSchema } from 'typebox';
import { Check } from 'typebox/value';

import { isJsonObject, isJsonValue, type JsonObject } from './json.js';

const closed = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const identifier = Type.String({ minLength: 1, maxLength: 256 });
const pointer = Type.String({
  maxLength: 512,
  pattern: '^(?:/(?:[^~/]|~[01])*)*$',
});
const positiveSafeInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export type RunManagerErrorCode =
  | 'agent_runtime_unavailable'
  | 'invalid_list_runs_filter'
  | 'invalid_create_run_input'
  | 'invalid_run_id'
  | 'invalid_run_event_page_input'
  | 'invalid_run_event_subscription_input'
  | 'invalid_wait_for_terminal_input'
  | 'manager_not_started'
  | 'manager_start_failed'
  | 'manager_stop_failed'
  | 'pipeline_compilation_failed'
  | 'run_admission_failed'
  | 'run_id_conflict'
  | 'run_event_cursor_invalid'
  | 'run_event_subscription_failed'
  | 'run_gate_already_resolved'
  | 'run_gate_answer_invalid'
  | 'run_gate_not_found'
  | 'run_gate_payload_invalid'
  | 'run_gate_unauthorized'
  | 'run_interaction_failed'
  | 'run_not_found'
  | 'run_profile_invalid'
  | 'run_read_failed'
  | 'run_recovery_required'
  | 'run_requirement_unresolved'
  | 'run_signal_invalid'
  | 'run_signal_payload_invalid'
  | 'run_wait_aborted'
  | 'run_wait_already_resolved'
  | 'run_wait_not_found'
  | 'run_wait_timed_out';

const messages: Readonly<Record<RunManagerErrorCode, string>> = {
  agent_runtime_unavailable: 'Agent runtime is unavailable.',
  invalid_list_runs_filter: 'Run-list filter is invalid.',
  invalid_create_run_input: 'Create-run input is invalid.',
  invalid_run_id: 'Run ID is invalid.',
  invalid_run_event_page_input: 'Run-event page input is invalid.',
  invalid_run_event_subscription_input: 'Run-event subscription input is invalid.',
  invalid_wait_for_terminal_input: 'Wait-for-terminal input is invalid.',
  manager_not_started: 'Run manager is not started.',
  manager_start_failed: 'Run manager failed to start.',
  manager_stop_failed: 'Run manager failed to stop.',
  pipeline_compilation_failed: 'Pipeline compilation failed.',
  run_admission_failed: 'Run admission failed.',
  run_event_cursor_invalid: 'Run-event cursor is invalid.',
  run_event_subscription_failed: 'Run-event subscription failed.',
  run_gate_already_resolved: 'Human gate is already resolved.',
  run_gate_answer_invalid: 'Human-gate answer is invalid.',
  run_gate_not_found: 'Pending human gate was not found.',
  run_gate_payload_invalid: 'Human-gate payload is invalid.',
  run_gate_unauthorized: 'Actor is not authorized to answer the human gate.',
  run_id_conflict: 'Run ID is already admitted.',
  run_interaction_failed: 'Run interaction could not be committed.',
  run_not_found: 'Run was not found.',
  run_profile_invalid: 'Run profile is invalid.',
  run_read_failed: 'Run observation could not be read.',
  run_recovery_required: 'Run requires recovery before it can continue.',
  run_requirement_unresolved: 'A run requirement could not be resolved.',
  run_signal_invalid: 'Signal name is invalid for the pending wait.',
  run_signal_payload_invalid: 'Signal payload is invalid.',
  run_wait_aborted: 'Waiting for the run was aborted.',
  run_wait_already_resolved: 'Signal wait is already resolved.',
  run_wait_not_found: 'Pending signal wait was not found.',
  run_wait_timed_out: 'Waiting for the run timed out.',
};

const errorCodeValues = {
  agent_runtime_unavailable: 'agent_runtime_unavailable',
  invalid_list_runs_filter: 'invalid_list_runs_filter',
  invalid_create_run_input: 'invalid_create_run_input',
  invalid_run_id: 'invalid_run_id',
  invalid_run_event_page_input: 'invalid_run_event_page_input',
  invalid_run_event_subscription_input: 'invalid_run_event_subscription_input',
  invalid_wait_for_terminal_input: 'invalid_wait_for_terminal_input',
  manager_not_started: 'manager_not_started',
  manager_start_failed: 'manager_start_failed',
  manager_stop_failed: 'manager_stop_failed',
  pipeline_compilation_failed: 'pipeline_compilation_failed',
  run_admission_failed: 'run_admission_failed',
  run_id_conflict: 'run_id_conflict',
  run_event_cursor_invalid: 'run_event_cursor_invalid',
  run_event_subscription_failed: 'run_event_subscription_failed',
  run_gate_already_resolved: 'run_gate_already_resolved',
  run_gate_answer_invalid: 'run_gate_answer_invalid',
  run_gate_not_found: 'run_gate_not_found',
  run_gate_payload_invalid: 'run_gate_payload_invalid',
  run_gate_unauthorized: 'run_gate_unauthorized',
  run_interaction_failed: 'run_interaction_failed',
  run_not_found: 'run_not_found',
  run_profile_invalid: 'run_profile_invalid',
  run_read_failed: 'run_read_failed',
  run_recovery_required: 'run_recovery_required',
  run_requirement_unresolved: 'run_requirement_unresolved',
  run_signal_invalid: 'run_signal_invalid',
  run_signal_payload_invalid: 'run_signal_payload_invalid',
  run_wait_aborted: 'run_wait_aborted',
  run_wait_already_resolved: 'run_wait_already_resolved',
  run_wait_not_found: 'run_wait_not_found',
  run_wait_timed_out: 'run_wait_timed_out',
} as const;

export const RunManagerErrorCodeSchema = Type.Enum(errorCodeValues);

const invalidInputDetails = closed({ path: pointer, reason: identifier });
const requirementDetails = closed({
  requirementKey: identifier,
  bindingKey: Type.Union([identifier, Type.Null()]),
  reason: identifier,
});
const runIdDetails = closed({ runId: identifier });
const interactionDetails = closed({
  runId: identifier,
  operation: Type.Union([Type.Literal('cancel'), Type.Literal('signal'), Type.Literal('gate')]),
});
const readOperation = Type.Union([
  Type.Literal('get_run'),
  Type.Literal('list_runs'),
  Type.Literal('get_details'),
  Type.Literal('get_events'),
  Type.Literal('wait_for_terminal'),
]);
const attemptDetails = closed({
  runId: identifier,
  attempts: Type.Array(closed({ operationId: identifier, attemptId: identifier })),
});
const waitDetails = closed({ runId: identifier, waitId: identifier, path: Type.Null() });
const gateDetails = closed({ runId: identifier, gateId: identifier, path: Type.Null() });

export const RunManagerErrorSchema = Type.Union([
  closed({ code: Type.Literal('agent_runtime_unavailable'), details: closed({}) }),
  closed({ code: Type.Literal('invalid_list_runs_filter'), details: invalidInputDetails }),
  closed({ code: Type.Literal('invalid_create_run_input'), details: invalidInputDetails }),
  closed({ code: Type.Literal('invalid_run_id'), details: invalidInputDetails }),
  closed({ code: Type.Literal('invalid_run_event_page_input'), details: invalidInputDetails }),
  closed({
    code: Type.Literal('invalid_run_event_subscription_input'),
    details: invalidInputDetails,
  }),
  closed({ code: Type.Literal('invalid_wait_for_terminal_input'), details: invalidInputDetails }),
  closed({
    code: Type.Literal('manager_not_started'),
    details: closed({
      lifecycle: Type.Union([
        Type.Literal('created'),
        Type.Literal('stopping'),
        Type.Literal('stopped'),
      ]),
    }),
  }),
  closed({
    code: Type.Literal('manager_start_failed'),
    details: closed({
      operation: Type.Union([Type.Literal('dbos_launch'), Type.Literal('host_initialization')]),
    }),
  }),
  closed({
    code: Type.Literal('manager_stop_failed'),
    details: closed({
      operation: Type.Union([
        Type.Literal('agent_shutdown'),
        Type.Literal('scripts_shutdown'),
        Type.Literal('dbos_shutdown'),
      ]),
    }),
  }),
  closed({
    code: Type.Literal('pipeline_compilation_failed'),
    details: closed({ diagnostics: Type.Array(Type.Any()) }),
  }),
  closed({
    code: Type.Literal('run_admission_failed'),
    details: closed({
      operation: Type.Union([Type.Literal('admission_commit'), Type.Literal('workflow_start')]),
    }),
  }),
  closed({ code: Type.Literal('run_id_conflict'), details: runIdDetails }),
  closed({ code: Type.Literal('run_not_found'), details: runIdDetails }),
  closed({ code: Type.Literal('run_profile_invalid'), details: invalidInputDetails }),
  closed({ code: Type.Literal('run_requirement_unresolved'), details: requirementDetails }),
  closed({ code: Type.Literal('run_recovery_required'), details: attemptDetails }),
  closed({
    code: Type.Literal('run_read_failed'),
    details: closed({ runId: Type.Union([identifier, Type.Null()]), operation: readOperation }),
  }),
  closed({
    code: Type.Literal('run_event_cursor_invalid'),
    details: closed({
      runId: identifier,
      reason: Type.Union([
        Type.Literal('malformed'),
        Type.Literal('foreign'),
        Type.Literal('ahead'),
      ]),
    }),
  }),
  closed({ code: Type.Literal('run_event_subscription_failed'), details: runIdDetails }),
  closed({ code: Type.Literal('run_interaction_failed'), details: interactionDetails }),
  closed({
    code: Type.Literal('run_wait_timed_out'),
    details: closed({ runId: identifier, timeoutMs: positiveSafeInteger }),
  }),
  closed({ code: Type.Literal('run_wait_aborted'), details: runIdDetails }),
  closed({ code: Type.Literal('run_wait_not_found'), details: waitDetails }),
  closed({ code: Type.Literal('run_wait_already_resolved'), details: waitDetails }),
  closed({
    code: Type.Literal('run_signal_invalid'),
    details: closed({ runId: identifier, waitId: identifier, path: Type.Literal('/signal') }),
  }),
  closed({
    code: Type.Literal('run_signal_payload_invalid'),
    details: closed({ runId: identifier, waitId: identifier, path: Type.Literal('/payload') }),
  }),
  closed({ code: Type.Literal('run_gate_not_found'), details: gateDetails }),
  closed({ code: Type.Literal('run_gate_already_resolved'), details: gateDetails }),
  closed({
    code: Type.Literal('run_gate_answer_invalid'),
    details: closed({ runId: identifier, gateId: identifier, path: Type.Literal('/answer') }),
  }),
  closed({
    code: Type.Literal('run_gate_payload_invalid'),
    details: closed({ runId: identifier, gateId: identifier, path: Type.Literal('/payload') }),
  }),
  closed({ code: Type.Literal('run_gate_unauthorized'), details: gateDetails }),
]);
export type RunManagerErrorContract = Static<typeof RunManagerErrorSchema>;
export const RunManagerErrorDetailsSchema = Type.Unsafe<JsonObject>(
  Type.Union([
    closed({}),
    invalidInputDetails,
    requirementDetails,
    runIdDetails,
    interactionDetails,
    attemptDetails,
    waitDetails,
    gateDetails,
    closed({
      lifecycle: Type.Union([
        Type.Literal('created'),
        Type.Literal('stopping'),
        Type.Literal('stopped'),
      ]),
    }),
    closed({
      operation: Type.Union([Type.Literal('dbos_launch'), Type.Literal('host_initialization')]),
    }),
    closed({
      operation: Type.Union([
        Type.Literal('agent_shutdown'),
        Type.Literal('scripts_shutdown'),
        Type.Literal('dbos_shutdown'),
      ]),
    }),
    closed({ diagnostics: Type.Array(Type.Any()) }),
    closed({
      operation: Type.Union([Type.Literal('admission_commit'), Type.Literal('workflow_start')]),
    }),
    closed({ runId: Type.Union([identifier, Type.Null()]), operation: readOperation }),
    closed({
      runId: identifier,
      reason: Type.Union([
        Type.Literal('malformed'),
        Type.Literal('foreign'),
        Type.Literal('ahead'),
      ]),
    }),
    closed({ runId: identifier, timeoutMs: Type.Integer({ minimum: 1 }) }),
    closed({ runId: identifier, waitId: identifier, path: Type.Literal('/signal') }),
    closed({ runId: identifier, waitId: identifier, path: Type.Literal('/payload') }),
    closed({ runId: identifier, gateId: identifier, path: Type.Literal('/answer') }),
    closed({ runId: identifier, gateId: identifier, path: Type.Literal('/payload') }),
  ]),
);

export class RunManagerError extends Error {
  readonly code: RunManagerErrorCode;
  readonly details: JsonObject;

  constructor(code: RunManagerErrorCode, details: JsonObject = {}) {
    if (!Check(RunManagerErrorSchema, { code, details })) {
      throw new Error('Run-manager error details violate the public contract.');
    }
    super(messages[code]);
    this.name = 'RunManagerError';
    this.code = code;
    this.details = Object.freeze(structuredClone(details));
  }
}

export const pipelineCompilationError = (
  diagnostics: readonly PipelineDiagnostic[],
): RunManagerError => {
  const cloned: unknown = structuredClone(diagnostics);
  const details: unknown = { diagnostics: cloned };
  return new RunManagerError(
    'pipeline_compilation_failed',
    isJsonObject(details) && isJsonValue(cloned) ? details : {},
  );
};
