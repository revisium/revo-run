import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';

export const RunManagerErrorCodeSchema = Type.Union([
  Type.Literal('manager_not_started'),
  Type.Literal('manager_start_failed'),
  Type.Literal('manager_stop_failed'),
  Type.Literal('invalid_run_id'),
  Type.Literal('invalid_start_run_input'),
  Type.Literal('invalid_cancel_run_input'),
  Type.Literal('invalid_resolve_unknown_outcome_input'),
  Type.Literal('invalid_answer_gate_input'),
  Type.Literal('unsupported_plan_schema_version'),
  Type.Literal('invalid_execution_plan'),
  Type.Literal('invalid_pipeline_id'),
  Type.Literal('invalid_node_key'),
  Type.Literal('invalid_repeat_bound'),
  Type.Literal('overlapping_repeat_outcome_sets'),
  Type.Literal('unsupported_gate_conflict_policy'),
  Type.Literal('reserved_gate_answer'),
  Type.Literal('root_pipeline_not_found'),
  Type.Literal('pipeline_not_found'),
  Type.Literal('duplicate_node_key'),
  Type.Literal('node_depth_exceeded'),
  Type.Literal('subpipeline_cycle'),
  Type.Literal('subpipeline_depth_exceeded'),
  Type.Literal('missing_branch_default'),
  Type.Literal('unreachable_parallel_threshold'),
  Type.Literal('unreachable_consensus_threshold'),
  Type.Literal('execution_bound_exceeded'),
  Type.Literal('duplicate_executor_binding'),
  Type.Literal('binding_target_not_found'),
  Type.Literal('binding_target_not_task'),
  Type.Literal('missing_executor_binding'),
  Type.Literal('recovery_reconcile_required'),
  Type.Literal('recovery_human_resolution_unsupported'),
  Type.Literal('run_id_conflict'),
  Type.Literal('run_admission_failed'),
  Type.Literal('run_command_failed'),
  Type.Literal('run_not_found'),
  Type.Literal('invalid_list_runs_input'),
  Type.Literal('invalid_run_event_page_input'),
  Type.Literal('invalid_run_event_subscription_input'),
  Type.Literal('invalid_run_event_cursor'),
  Type.Literal('invalid_wait_for_terminal_input'),
  Type.Literal('run_read_failed'),
  Type.Literal('run_event_subscription_failed'),
  Type.Literal('run_wait_timed_out'),
  Type.Literal('run_wait_aborted'),
]);

export type RunManagerErrorCode = DeepReadonly<Type.Static<typeof RunManagerErrorCodeSchema>>;

const messages: Readonly<Record<RunManagerErrorCode, string>> = {
  manager_not_started: 'Run manager is not started.',
  manager_start_failed: 'Run manager failed to start.',
  manager_stop_failed: 'Run manager failed to stop.',
  invalid_run_id: 'Run ID is invalid.',
  invalid_start_run_input: 'Start run input is invalid.',
  invalid_cancel_run_input: 'Cancel run input is invalid.',
  invalid_resolve_unknown_outcome_input: 'Resolve unknown outcome input is invalid.',
  invalid_answer_gate_input: 'Answer gate input is invalid.',
  unsupported_plan_schema_version: 'Execution plan schema version is unsupported.',
  invalid_execution_plan: 'Execution plan is invalid.',
  invalid_pipeline_id: 'Execution plan pipeline ID is invalid.',
  invalid_node_key: 'Execution plan node key is invalid.',
  invalid_repeat_bound: 'Execution plan repeat bound is invalid.',
  overlapping_repeat_outcome_sets: 'Execution plan repeat outcome sets overlap.',
  unsupported_gate_conflict_policy: 'Execution plan human gate conflict policy is unsupported.',
  reserved_gate_answer: 'Execution plan human gate answer is reserved.',
  root_pipeline_not_found: 'Execution plan root pipeline was not found.',
  pipeline_not_found: 'Execution plan pipeline was not found.',
  duplicate_node_key: 'Execution plan contains a duplicate node key.',
  node_depth_exceeded: 'Execution plan node depth is exceeded.',
  subpipeline_cycle: 'Execution plan contains a subpipeline cycle.',
  subpipeline_depth_exceeded: 'Execution plan subpipeline depth is exceeded.',
  missing_branch_default: 'Execution plan branch default is required.',
  unreachable_parallel_threshold: 'Execution plan parallel threshold is unreachable.',
  unreachable_consensus_threshold: 'Execution plan consensus threshold is unreachable.',
  execution_bound_exceeded: 'Execution plan execution bound is exceeded.',
  duplicate_executor_binding: 'Execution plan contains a duplicate executor binding.',
  binding_target_not_found: 'Execution plan binding target was not found.',
  binding_target_not_task: 'Execution plan binding target is not a task.',
  missing_executor_binding: 'Execution plan task binding is missing.',
  recovery_reconcile_required: 'Execution plan recovery requires executor reconciliation.',
  recovery_human_resolution_unsupported: 'Human resolution recovery is not supported.',
  run_id_conflict: 'Run ID is already claimed.',
  run_admission_failed: 'Run admission failed.',
  run_command_failed: 'Run command failed.',
  run_not_found: 'Run was not found.',
  invalid_list_runs_input: 'Run list input is invalid.',
  invalid_run_event_page_input: 'Run event page input is invalid.',
  invalid_run_event_subscription_input: 'Run event subscription input is invalid.',
  invalid_run_event_cursor: 'Run event cursor is invalid.',
  invalid_wait_for_terminal_input: 'Run wait input is invalid.',
  run_read_failed: 'Run could not be read.',
  run_event_subscription_failed: 'Run event subscription failed.',
  run_wait_timed_out: 'Run wait timed out.',
  run_wait_aborted: 'Run wait was aborted.',
};

export class RunManagerError extends Error {
  readonly code: RunManagerErrorCode;
  readonly commandId?: string;

  constructor(code: RunManagerErrorCode, commandId?: string) {
    super(messages[code]);
    this.name = 'RunManagerError';
    this.code = code;
    if (commandId !== undefined) {
      this.commandId = commandId;
    }
  }
}
