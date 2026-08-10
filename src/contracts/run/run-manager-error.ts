import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';

export const RunManagerErrorCodeSchema = Type.Union([
  Type.Literal('manager_not_started'),
  Type.Literal('manager_start_failed'),
  Type.Literal('manager_stop_failed'),
  Type.Literal('invalid_run_id'),
  Type.Literal('invalid_start_run_input'),
  Type.Literal('unsupported_plan_schema_version'),
  Type.Literal('invalid_execution_plan'),
  Type.Literal('invalid_pipeline_id'),
  Type.Literal('invalid_node_key'),
  Type.Literal('invalid_repeat_bound'),
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
  Type.Literal('run_id_conflict'),
  Type.Literal('run_admission_failed'),
  Type.Literal('run_not_found'),
  Type.Literal('run_read_failed'),
  Type.Literal('run_event_subscription_failed'),
]);

export type RunManagerErrorCode = DeepReadonly<Type.Static<typeof RunManagerErrorCodeSchema>>;

const messages: Readonly<Record<RunManagerErrorCode, string>> = {
  manager_not_started: 'Run manager is not started.',
  manager_start_failed: 'Run manager failed to start.',
  manager_stop_failed: 'Run manager failed to stop.',
  invalid_run_id: 'Run ID is invalid.',
  invalid_start_run_input: 'Start run input is invalid.',
  unsupported_plan_schema_version: 'Execution plan schema version is unsupported.',
  invalid_execution_plan: 'Execution plan is invalid.',
  invalid_pipeline_id: 'Execution plan pipeline ID is invalid.',
  invalid_node_key: 'Execution plan node key is invalid.',
  invalid_repeat_bound: 'Execution plan repeat bound is invalid.',
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
  run_id_conflict: 'Run ID is already claimed.',
  run_admission_failed: 'Run admission failed.',
  run_not_found: 'Run was not found.',
  run_read_failed: 'Run could not be read.',
  run_event_subscription_failed: 'Run event subscription failed.',
};

export class RunManagerError extends Error {
  readonly code: RunManagerErrorCode;

  constructor(code: RunManagerErrorCode) {
    super(messages[code]);
    this.name = 'RunManagerError';
    this.code = code;
  }
}
