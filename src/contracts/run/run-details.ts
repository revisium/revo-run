import type { AttemptId, AuthoredNodeId, NodeInstanceId, ScopeId } from '../execution-identity.js';
import type { NodeOutput } from '../pipeline/node-output.js';
import type { RunSnapshot } from './run.js';

export type RunNodeExecutionStatus = 'completed' | 'failed' | 'outcomeUnknown' | 'timedOut';

interface RunWorkflowScopeBase {
  readonly id: ScopeId;
  readonly pipelineId: string;
  readonly displayPath: string;
  readonly status: import('./run.js').RunStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
}

export type RunScope =
  | (RunWorkflowScopeBase & { readonly kind: 'root' })
  | (RunWorkflowScopeBase & {
      readonly kind: 'parallelBranch';
      readonly parentScopeId: ScopeId;
    })
  | {
      readonly kind: 'inlineSubpipeline';
      readonly id: ScopeId;
      readonly parentScopeId: ScopeId;
      readonly pipelineId: string;
      readonly displayPath: string;
    };

export interface RunNodeInstance {
  readonly id: NodeInstanceId;
  readonly scopeId: ScopeId;
  readonly authoredNodeId: AuthoredNodeId;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly displayPath: string;
  readonly status: RunNodeExecutionStatus;
  readonly attemptIds: readonly AttemptId[];
  readonly startedAt?: Date;
  readonly completedAt?: Date;
}

interface RunAttemptBase {
  readonly id: AttemptId;
  readonly nodeInstanceId: NodeInstanceId;
  readonly ordinal: number;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
}

export type RunAttempt =
  | (RunAttemptBase & {
      readonly status: 'completed';
      readonly outcome: string;
      readonly output?: NodeOutput;
    })
  | (RunAttemptBase & {
      readonly status: 'failed';
      readonly error: { readonly code: string };
    })
  | (RunAttemptBase & {
      readonly status: 'outcomeUnknown';
      readonly recovery: { readonly reconciliationRound: number };
    })
  | (RunAttemptBase & { readonly status: 'timedOut' });

export interface RunDetails {
  readonly run: RunSnapshot;
  readonly scopes: readonly RunScope[];
  readonly nodeInstances: readonly RunNodeInstance[];
  readonly attempts: readonly RunAttempt[];
}
