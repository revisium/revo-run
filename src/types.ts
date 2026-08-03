export type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ExecutionPlanPin {
  readonly id: string;
  readonly revision: string;
  readonly digest: string;
}

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface RunSnapshot {
  readonly id: string;
  readonly planPin: ExecutionPlanPin;
  readonly input: JsonValue;
  readonly status: RunStatus;
  readonly result: JsonValue | null;
  readonly error: string | null;
}

export interface RunPlanSource {
  loadExact(pin: ExecutionPlanPin): Promise<{
    readonly compiledPipeline: JsonValue;
    readonly taskInputs?: Readonly<Record<string, JsonValue>>;
  }>;
}

export interface RunExecutor {
  execute(request: {
    readonly runId: string;
    readonly nodeKey: string;
    readonly candidate?: string;
    readonly input: JsonValue;
  }): Promise<{ readonly outcome: 'completed' | 'failed'; readonly output?: JsonValue }>;
}

export interface RunSnapshotStore {
  create(snapshot: RunSnapshot): Promise<void>;
  update(snapshot: RunSnapshot): Promise<void>;
  get(runId: string): Promise<RunSnapshot | undefined>;
}

export interface CreateRunManagerOptions {
  readonly database: { readonly url: string };
  readonly plans: RunPlanSource;
  readonly executor: RunExecutor;
  readonly snapshots: RunSnapshotStore;
}

export interface RunManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  startRun(request: {
    readonly planPin: ExecutionPlanPin;
    readonly input: JsonValue;
  }): Promise<RunSnapshot>;
  getRun(runId: string): Promise<RunSnapshot | undefined>;
}
