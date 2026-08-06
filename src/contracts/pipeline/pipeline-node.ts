import type { InputSource, TerminalOutputSource } from './data-reference.js';
import type { RecoveryPolicy, RetryPolicy } from './task-policy.js';

export type InputMapping = Readonly<Record<string, InputSource>>;

export type TerminalOutputMapping = Readonly<Record<string, TerminalOutputSource>>;

// TypeBox intentionally widens deeply recursive static types. PipelineNode is one of the two
// reviewed recursive seams where the immutable TypeScript contract remains explicit.
export type PipelineNode =
  | BranchNode
  | ConsensusNode
  | DelayNode
  | EndNode
  | HumanGateNode
  | MapNode
  | OutcomeSwitchNode
  | ParallelNode
  | RepeatNode
  | SequenceNode
  | SubpipelineNode
  | TaskNode;

export interface TaskNode {
  readonly kind: 'task';
  readonly key: string;
  readonly input?: InputMapping;
  readonly retry?: RetryPolicy;
  readonly recovery?: RecoveryPolicy;
  readonly timeoutMs?: number;
}

export interface SequenceNode {
  readonly kind: 'sequence';
  readonly children: readonly PipelineNode[];
}

export interface OutcomeSwitchNode {
  readonly kind: 'outcomeSwitch';
  readonly source: PipelineNode;
  readonly cases: Readonly<Record<string, PipelineNode>>;
  readonly default?: PipelineNode;
}

export interface BranchNode {
  readonly kind: 'branch';
  readonly key: string;
  readonly value: InputSource;
  readonly cases: Readonly<Record<string, PipelineNode>>;
  readonly default?: PipelineNode;
}

export type RemainingBranchPolicy = 'cancel' | 'drain';

export type ParallelJoinPolicy =
  | {
      readonly kind: 'all';
      readonly successfulOutcomes: readonly string[];
      readonly remaining: RemainingBranchPolicy;
    }
  | {
      readonly kind: 'any';
      readonly successfulOutcomes: readonly string[];
      readonly remaining: RemainingBranchPolicy;
    }
  | {
      readonly kind: 'threshold';
      readonly count: number;
      readonly successfulOutcomes: readonly string[];
      readonly remaining: RemainingBranchPolicy;
    };

export interface ParallelNode {
  readonly kind: 'parallel';
  readonly key: string;
  readonly branches: Readonly<Record<string, PipelineNode>>;
  readonly join: ParallelJoinPolicy;
}

export type ConsensusPolicy =
  | { readonly kind: 'unanimous' }
  | { readonly kind: 'quorum'; readonly count: number }
  | {
      readonly kind: 'threshold';
      readonly approve: number;
      readonly reject: number;
    };

export interface ConsensusNode {
  readonly kind: 'consensus';
  readonly key: string;
  readonly participants: Readonly<Record<string, TaskNode>>;
  readonly policy: ConsensusPolicy;
  readonly remaining: RemainingBranchPolicy;
  readonly timeoutMs?: number;
}

export interface HumanGateNode {
  readonly kind: 'humanGate';
  readonly key: string;
  readonly answers: readonly string[];
  readonly decision:
    | { readonly kind: 'firstAnswer' }
    | {
        readonly kind: 'matchingAnswers';
        readonly count: number;
        readonly onConflict: 'conflict' | 'wait';
      };
  readonly eligibleGroup?: string;
  readonly timeoutMs?: number;
}

export interface RepeatNode {
  readonly kind: 'repeat';
  readonly key: string;
  readonly maximumIterations: number;
  readonly continueOn: readonly string[];
  readonly completeOn: readonly string[];
  readonly initialInput?: InputMapping;
  readonly nextInput?: InputMapping;
  readonly body: PipelineNode;
}

export interface SubpipelineNode {
  readonly kind: 'subpipeline';
  readonly key: string;
  readonly pipelineId: string;
  readonly input?: InputMapping;
}

export interface MapNode {
  readonly kind: 'map';
  readonly key: string;
  readonly items: InputSource;
  readonly itemKeyPath: string;
  readonly maximumItems: number;
  readonly concurrency: number;
  readonly failure:
    | { readonly kind: 'failFast'; readonly remaining: RemainingBranchPolicy }
    | { readonly kind: 'collect' };
  readonly body: PipelineNode;
}

export interface DelayNode {
  readonly kind: 'delay';
  readonly key: string;
  readonly durationMs: number;
}

export interface EndNode {
  readonly kind: 'end';
  readonly status: 'cancelled' | 'failed' | 'succeeded';
  readonly outcome: string;
  readonly output?: TerminalOutputMapping;
}
