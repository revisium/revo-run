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

export interface PreparedAgentBinding {
  readonly schemaVersion: 'prepared-agent-binding/v1';
  readonly pin: AgentExecutionPin;
  readonly parameters: JsonObject;
  readonly permissions: JsonObject;
  readonly workspaceRef: string;
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
}

export interface AgentRuntimeStartInput {
  readonly invocationId: string;
  readonly binding: PreparedAgentBinding;
  readonly prompt: string;
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
}

export interface AgentTerminalFailure {
  readonly code: string;
  readonly message: string;
}

interface AgentTerminalResultBase {
  readonly schemaVersion: 'agent-terminal-result/v1';
  readonly invocationId: string;
  readonly pin: AgentExecutionPin;
}

export type AgentTerminalResult =
  | (AgentTerminalResultBase &
      Readonly<{
        readonly status: 'succeeded';
        readonly value: JsonObject;
      }>)
  | (AgentTerminalResultBase &
      Readonly<{
        readonly status: 'failed' | 'timed_out';
        readonly error: AgentTerminalFailure;
      }>)
  | (AgentTerminalResultBase &
      Readonly<{
        readonly status: 'cancelled';
      }>);

export interface AgentInvocationSnapshot {
  readonly invocationId: string;
  readonly pin: AgentExecutionPin;
  readonly status: 'accepted' | 'starting' | 'running' | 'cancelling';
}

export type AgentResultLookup =
  | Readonly<{ readonly state: 'running'; readonly invocation: AgentInvocationSnapshot }>
  | Readonly<{ readonly state: 'completed'; readonly result: AgentTerminalResult }>
  | Readonly<{ readonly state: 'unknown' }>;

export type CancelInvocationResult =
  | Readonly<{ readonly state: 'requested' }>
  | Readonly<{ readonly state: 'already_completed'; readonly result: AgentTerminalResult }>
  | Readonly<{ readonly state: 'unknown' }>;

export interface AgentInvocationHandle {
  readonly invocationId: string;
  readonly pin: AgentExecutionPin;
  result(): Promise<AgentTerminalResult>;
  cancel(reason?: string): Promise<CancelInvocationResult>;
}

export type AgentStartOutcome =
  | Readonly<{ readonly status: 'accepted'; readonly handle: AgentInvocationHandle }>
  | Readonly<{ readonly status: 'rejected'; readonly result: AgentTerminalResult }>
  | Readonly<{ readonly status: 'unknown' }>;

export interface AgentRuntimePort {
  initialize(snapshots: readonly ActiveInvocationSnapshot[]): Promise<void>;
  prepareBinding(input: AgentBindingInput): Promise<PreparedAgentBinding>;
  start(input: AgentRuntimeStartInput, context?: AgentStartContext): Promise<AgentStartOutcome>;
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
