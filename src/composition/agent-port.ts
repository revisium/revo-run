import type { JsonObject } from '../contracts/json.js';
import { RunManagerError } from '../contracts/run-manager-error.js';

export interface AgentRef {
  readonly id: string;
  readonly version: string;
}

export interface AgentExecutionPin {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly definitionDigest: string;
}

export interface AgentBindingInput {
  readonly definition: AgentRef;
  readonly parameters: JsonObject;
  readonly permissions: JsonObject;
  readonly workspaceRef: string;
  readonly credentials?: Readonly<Record<string, string>>;
}

export interface PreparedAgentDefinitionSnapshot {
  readonly schemaVersion: 'prepared-agent-definition-snapshot/v1';
  readonly value: JsonObject;
}

export interface PreparedAgentBinding {
  readonly schemaVersion: 'prepared-agent-binding/v1';
  readonly definition: PreparedAgentDefinitionSnapshot;
  readonly pin: AgentExecutionPin;
  readonly parameters: JsonObject;
  readonly permissions: JsonObject;
  readonly workspaceRef: string;
  readonly credentials: Readonly<
    Record<string, Readonly<{ readonly alias: string; readonly environmentVariable: string }>>
  >;
}

export interface ActiveInvocationSnapshot {
  readonly invocationId: string;
  readonly pin: AgentExecutionPin;
  readonly state: 'running' | 'cancelling';
  readonly process: Readonly<{
    readonly pid: number;
    readonly processGroupId: number;
    readonly fingerprint: string;
    readonly startedAt: string;
  }>;
}

export interface AgentStartContext {
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<{
    readonly inherit?: readonly string[];
    readonly variables?: Readonly<Record<string, string>>;
    readonly secrets?: Readonly<Record<string, string>>;
  }>;
}

export interface StartAgentInvocation {
  readonly invocationId: string;
  readonly agent: AgentRef;
  readonly prompt: string;
  readonly workspace: Readonly<{ readonly directory: string }>;
  readonly parameters: JsonObject;
  readonly permissions: JsonObject;
  readonly metadata?: JsonObject;
  readonly result: Readonly<{ readonly schema: JsonObject }>;
  readonly limits?: Readonly<{
    readonly wallClockTimeoutMs?: number;
    readonly idleTimeoutMs?: number;
    readonly maxEventBytes?: number;
    readonly maxEventsFileBytes?: number;
    readonly maxStdoutBytes?: number;
    readonly maxStderrBytes?: number;
    readonly maxRawResponseBytes?: number;
  }>;
  readonly output: Readonly<{ readonly directory: string }>;
}

export interface AgentOutputFiles {
  readonly directory: string;
  readonly events: 'events.ndjson';
  readonly stdout: 'stdout.log';
  readonly stderr: 'stderr.log';
  readonly result?: 'result.json';
  readonly rawFinalResponse?: 'raw-final-response.txt';
}

export interface AgentCommittedOutputFiles extends AgentOutputFiles {
  readonly result: 'result.json';
}

export type AgentFaultCode =
  | 'revo.agent.definition_invalid'
  | 'revo.agent.definition_duplicate'
  | 'revo.agent.strategy_unsupported'
  | 'revo.agent.limit_invalid'
  | 'revo.agent.agent_unknown'
  | 'revo.agent.invocation_invalid'
  | 'revo.agent.invocation_duplicate'
  | 'revo.agent.invocation_unknown'
  | 'revo.agent.workspace_invalid'
  | 'revo.agent.parameters_invalid'
  | 'revo.agent.permissions_invalid'
  | 'revo.agent.result_schema_invalid'
  | 'revo.agent.environment_invalid'
  | 'revo.agent.output_path_invalid'
  | 'revo.agent.output_conflict'
  | 'revo.agent.scratch_failed'
  | 'revo.agent.spawn_failed'
  | 'revo.agent.authentication_failed'
  | 'revo.agent.permission_denied'
  | 'revo.agent.manager_not_initialized'
  | 'revo.agent.manager_closed'
  | 'revo.agent.shutdown_failed'
  | 'revo.agent.recovery_invalid'
  | 'revo.agent.recovery_failed'
  | 'revo.agent.platform_unsupported'
  | 'revo.agent.probe_platform_unsupported'
  | 'revo.agent.probe_spawn_failed'
  | 'revo.agent.probe_timeout'
  | 'revo.agent.probe_output_too_large'
  | 'revo.agent.probe_process_failed'
  | 'revo.agent.probe_output_invalid'
  | 'revo.agent.probe_version_mismatch'
  | 'revo.agent.protocol_failed'
  | 'revo.agent.output_write_failed'
  | 'revo.agent.active_state_failed'
  | 'revo.agent.process_identity_failed'
  | 'revo.agent.process_failed'
  | 'revo.agent.process_cleanup_failed'
  | 'revo.agent.result_missing'
  | 'revo.agent.result_too_large'
  | 'revo.agent.result_invalid_json'
  | 'revo.agent.result_not_object'
  | 'revo.agent.result_schema_mismatch'
  | 'revo.agent.scratch_cleanup_failed'
  | 'revo.agent.cancelled'
  | 'revo.agent.timeout'
  | 'revo.agent.internal';

export interface AgentFault {
  readonly code: AgentFaultCode;
  readonly message: string;
  readonly phase:
    | 'construction'
    | 'initializing'
    | 'manager'
    | 'shutdown'
    | 'probing'
    | 'preflight'
    | 'starting'
    | 'running'
    | 'collecting_result'
    | 'finalizing';
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export interface AgentRawResponseDiagnostic {
  readonly preview: string;
  readonly truncated: boolean;
  readonly file?: 'raw-final-response.txt';
}

interface AgentInvocationResultBase {
  readonly schemaVersion: 'agent-invocation-result/v1';
  readonly invocationId: string;
  readonly pin: AgentExecutionPin;
  readonly launch: Readonly<{ readonly executable: string; readonly reportedVersion: string }>;
  readonly metadata?: JsonObject;
  readonly acceptedAt: string;
  readonly startedAt?: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exit: Readonly<{ readonly code: number | null; readonly signal: string | null }>;
  readonly usage?: Readonly<{
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningOutputTokens?: number;
    readonly reportedCost?: number;
    readonly reportedCurrency?: string;
  }>;
  readonly files: AgentOutputFiles;
}

export type AgentInvocationResult =
  | (AgentInvocationResultBase &
      Readonly<{
        readonly status: 'succeeded';
        readonly value: JsonObject;
        readonly files: AgentCommittedOutputFiles;
      }>)
  | (AgentInvocationResultBase &
      Readonly<{
        readonly status: 'failed';
        readonly error: AgentFault;
        readonly rawResponse?: AgentRawResponseDiagnostic;
      }>)
  | (AgentInvocationResultBase &
      Readonly<{
        readonly status: 'cancelled' | 'timed_out';
        readonly error: AgentFault;
        readonly files: AgentCommittedOutputFiles;
      }>);

export interface AgentInvocationSnapshot {
  readonly invocationId: string;
  readonly pin: AgentExecutionPin;
  readonly status:
    | 'accepted'
    | 'starting'
    | 'running'
    | 'cancelling'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'timed_out';
  readonly metadata?: JsonObject;
  readonly acceptedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly outputDirectory: string;
}

export type AgentResultLookup =
  | Readonly<{ readonly state: 'running'; readonly invocation: AgentInvocationSnapshot }>
  | Readonly<{ readonly state: 'completed'; readonly result: AgentInvocationResult }>
  | Readonly<{ readonly state: 'unknown' }>;

export type CancelInvocationResult =
  | Readonly<{ readonly state: 'requested' }>
  | Readonly<{ readonly state: 'already_completed'; readonly result: AgentInvocationResult }>
  | Readonly<{ readonly state: 'unknown' }>;

export interface AgentInvocationHandle {
  readonly invocationId: string;
  readonly pin: AgentExecutionPin;
  result(): Promise<AgentInvocationResult>;
  cancel(reason?: string): Promise<CancelInvocationResult>;
}

export interface AgentRuntimePort {
  initialize(snapshots: readonly ActiveInvocationSnapshot[]): Promise<void>;
  prepareBinding(input: AgentBindingInput): Promise<PreparedAgentBinding>;
  start(input: StartAgentInvocation, context?: AgentStartContext): Promise<AgentInvocationHandle>;
  getResult(invocationId: string): AgentResultLookup;
  cancel(invocationId: string, reason?: string): Promise<CancelInvocationResult>;
  shutdown(reason?: string): Promise<void>;
}

const unavailable = (): never => {
  throw new RunManagerError('agent_runtime_unavailable');
};

export const unavailableAgentPort: AgentRuntimePort = Object.freeze({
  initialize: async (snapshots: readonly ActiveInvocationSnapshot[]) => {
    if (snapshots.length !== 0) {
      unavailable();
    }
  },
  prepareBinding: async () => unavailable(),
  start: async () => unavailable(),
  getResult: () => unavailable(),
  cancel: async () => unavailable(),
  shutdown: async () => undefined,
});
