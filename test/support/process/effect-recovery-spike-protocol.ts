export type EffectRecoverySpikeScope = 'parallel-child' | 'root-execution';

export type EffectRecoverySpikeScenario =
  | 'crash-after-effect'
  | 'crash-before-intent'
  | 'reconcile-crash'
  | 'reconcile-timeout'
  | 'single-wait';

export type EffectRecoverySpikePhase =
  | 'recover-complete'
  | 'recover-hold-reconcile'
  | 'recover-timeout'
  | 'start';

export interface EffectRecoverySpikeInput {
  readonly attemptId: string;
  readonly scenario: EffectRecoverySpikeScenario;
  readonly semanticWorkflowId: string;
}

export interface EffectRecoverySpikeMessage {
  readonly activeReconciliations?: number;
  readonly attemptOrdinal?: number;
  readonly kind:
    | 'effectExecuted'
    | 'error'
    | 'intentCheckpointed'
    | 'ready'
    | 'reconcileStarted'
    | 'reconcileTimedOut'
    | 'stopped'
    | 'terminal'
    | 'waiting';
  readonly liveGeneration?: number;
  readonly message?: string;
  readonly output?: unknown;
  readonly status?: string;
  readonly storedGeneration?: number;
}

export type EffectRecoverySpikeCommand = { readonly kind: 'resolveWait' };
