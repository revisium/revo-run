import type { PipelineSourcePackage } from '@revisium/revo-pipeline';
import type {
  CredentialResolver,
  ResourceResolver,
  WorkspaceResolver,
} from '@revisium/revo-scripts';

import type { JsonValue } from './json.js';
import type {
  RunDetails,
  RunEvent,
  RunEventPage,
  RunPage,
  RunSnapshot,
  RunStatus,
} from './observation.js';
import type { RunProfile } from './run-profile.js';

export interface CreateRunManagerOptions {
  readonly database: Readonly<{ readonly url: string }>;
  readonly host: Readonly<{
    readonly resources: ResourceResolver;
    readonly workspaces: WorkspaceResolver;
    readonly credentials: CredentialResolver;
  }>;
}

export interface CreateRunInput {
  readonly runId: string;
  readonly pipeline: PipelineSourcePackage;
  readonly profile: RunProfile;
  readonly input: JsonValue;
}

export interface CreateRunResult {
  readonly runId: string;
}

export interface CancelRunInput {
  readonly runId: string;
  readonly actorId: string;
}

export interface SendSignalInput {
  readonly runId: string;
  readonly waitId: string;
  readonly signal: string;
  readonly payload?: JsonValue;
  readonly actorId: string;
}

export interface AnswerGateInput {
  readonly runId: string;
  readonly gateId: string;
  readonly answer: string;
  readonly payload?: JsonValue;
  readonly actorId: string;
  readonly actorGroups?: readonly string[];
}

export interface ListRunsFilter {
  readonly statuses?: readonly RunStatus[];
  readonly createdAtFrom?: string;
  readonly createdAtTo?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface RunEventPageInput {
  readonly after?: string;
  readonly limit?: number;
}

export interface RunEventSubscriptionInput {
  readonly after?: string;
}

export interface WaitForTerminalInput {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RunManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  createRun(input: CreateRunInput): Promise<CreateRunResult>;
  getRun(runId: string): Promise<RunSnapshot | undefined>;
  listRuns(filter?: ListRunsFilter): Promise<RunPage>;
  getRunDetails(runId: string): Promise<RunDetails | undefined>;
  getRunEvents(runId: string, page?: RunEventPageInput): Promise<RunEventPage>;
  subscribeRunEvents(runId: string, input?: RunEventSubscriptionInput): AsyncIterable<RunEvent>;
  waitForTerminal(runId: string, input?: WaitForTerminalInput): Promise<RunSnapshot>;
  cancelRun(input: CancelRunInput): Promise<void>;
  sendSignal(input: SendSignalInput): Promise<void>;
  answerGate(input: AnswerGateInput): Promise<void>;
}
