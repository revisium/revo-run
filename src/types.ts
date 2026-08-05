import type {
  CandidateKey,
  CandidateVerdict,
  JsonValue,
  NodeKey,
  PipelineExecutionTemplate,
  ScriptIdentity,
} from '@revisium/revo-pipeline';

export type ExecutionPlan = PipelineExecutionTemplate;

export interface StartRunInput {
  readonly runId: string;
  readonly executionPlan: ExecutionPlan;
  readonly input: JsonValue;
}

export interface StartRunResult {
  readonly runId: string;
}

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type RunErrorCode =
  | 'execution_failed'
  | 'workflow_failed'
  | 'recovery_exhausted'
  | 'invalid_workflow_state';

export interface RunError {
  readonly code: RunErrorCode;
  readonly message: string;
}

export interface RunSnapshot {
  readonly id: string;
  readonly status: RunStatus;
  readonly executionPlan: ExecutionPlan;
  readonly input: JsonValue;
  readonly result?: JsonValue;
  readonly error?: RunError;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ExecutionInvocationBase {
  readonly executionId: string;
  readonly runId: string;
  readonly nodeKey: NodeKey;
  readonly input: JsonValue;
}

export type ExecutionInvocation =
  | (ExecutionInvocationBase & {
      readonly kind: 'task';
      readonly script?: ScriptIdentity;
    })
  | (ExecutionInvocationBase & {
      readonly kind: 'candidate';
      readonly candidateKey: CandidateKey;
    });

export type ExecutionCompletion =
  | { readonly kind: 'task'; readonly output?: JsonValue }
  | { readonly kind: 'candidate'; readonly verdict: CandidateVerdict['verdict'] };

export type ExecutionResult =
  | { readonly status: 'completed'; readonly completion: ExecutionCompletion }
  | {
      readonly status: 'failed';
      readonly error: { readonly code: 'execution_failed'; readonly message: string };
    }
  | { readonly status: 'outcome_unknown' };

export type ReconcileResult =
  | ExecutionResult
  | { readonly status: 'running' }
  | { readonly status: 'not_found' };

export type CancelResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'already_finished' }
  | { readonly status: 'not_supported' }
  | { readonly status: 'outcome_unknown' };

export interface RunExecutor {
  /** Calls must be bounded. executionId is the idempotency key for repeated execution attempts. */
  execute(invocation: ExecutionInvocation): Promise<ExecutionResult>;
  /** Calls must be bounded and repeatable. not_found authoritatively permits execute. */
  reconcile(invocation: ExecutionInvocation): Promise<ReconcileResult>;
  /** Calls must be bounded and repeatable. */
  cancel(invocation: ExecutionInvocation): Promise<CancelResult>;
}

export interface CreateRunManagerOptions {
  readonly database: { readonly url: string };
  readonly executor: RunExecutor;
}

export interface RunManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  startRun(input: StartRunInput): Promise<StartRunResult>;
  getRun(runId: string): Promise<RunSnapshot | undefined>;
}
