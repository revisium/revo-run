import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';
import { vi, type Mock } from 'vitest';

import {
  createRunManager,
  type JsonValue,
  type RunManager,
  type RunSnapshot,
} from '../../src/index.js';

const compilation = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'task',
    facts: [],
    nodes: [
      {
        kind: 'task',
        key: 'task',
        outcomes: { completed: 'review', failed: 'failed', cancelled: 'failed', skipped: 'failed' },
      },
      {
        kind: 'consensus',
        key: 'review',
        candidates: ['a', 'b'],
        policy: { kind: 'quorum', quorum: 2 },
        outcomes: { approved: 'done', rejected: 'failed', insufficient: 'failed', tied: 'failed' },
      },
      { kind: 'terminal', key: 'done', outcome: 'succeeded' },
      { kind: 'terminal', key: 'failed', outcome: 'failed' },
    ],
  }),
);
if (!compilation.ok) {
  throw new Error('run manager scenario pipeline is invalid');
}
const compiledPipeline = compilation.pipeline;

export interface RunManagerDbosControl {
  readonly ids: string[];
  readonly results: Promise<unknown>[];
  readonly launch: Mock<() => Promise<void>>;
  readonly setConfig: Mock<(configuration: unknown) => void>;
  readonly shutdown: Mock<() => Promise<void>>;
  readonly sleepms: Mock<(duration: number) => Promise<void>>;
  failNextSubmission(): void;
  missNextAdmission(): void;
  timeOutAdmission(): void;
  reset(): void;
}

const planPin = { id: 'p', revision: '1', digest: 'd' };

export class RunManagerScenario {
  private readonly dbos: RunManagerDbosControl;
  private readonly executor = vi.fn<() => Promise<{ outcome: 'completed' | 'failed' }>>();
  private readonly manager: RunManager;
  private readonly projectionFailures = new Map<RunSnapshot['status'], number>();
  private readonly snapshots = new Map<string, RunSnapshot>();
  private changeOutcomeOnTerminalProjectionFailure = false;
  private executorOutcome: 'completed' | 'failed' = 'completed';
  private planSource: JsonValue = compiledPipeline;

  constructor(dbos: RunManagerDbosControl) {
    this.dbos = dbos;
    dbos.reset();
    this.executor.mockImplementation(async () => ({ outcome: this.executorOutcome }));
    const project = async (snapshot: RunSnapshot): Promise<void> => {
      const remaining = this.projectionFailures.get(snapshot.status) ?? 0;
      if (remaining > 0) {
        this.projectionFailures.set(snapshot.status, remaining - 1);
        if (snapshot.status === 'succeeded' && this.changeOutcomeOnTerminalProjectionFailure) {
          this.executorOutcome = 'failed';
        }
        throw new Error('projection unavailable');
      }
      this.snapshots.set(snapshot.id, snapshot);
    };
    this.manager = createRunManager({
      database: { url: 'postgresql://test' },
      plans: {
        loadExact: async () => ({
          compiledPipeline: this.planSource,
          taskInputs: { task: ['exact'] },
        }),
      },
      executor: { execute: this.executor },
      snapshots: {
        create: project,
        update: project,
        get: async (id) => this.snapshots.get(id),
      },
    });
  }

  start(): Promise<void> {
    return this.manager.start();
  }

  stop(): Promise<void> {
    return this.manager.stop();
  }

  startRun(input: JsonValue = null): Promise<RunSnapshot> {
    return this.manager.startRun({ planPin, input });
  }

  startRunWith(plan: { id: string; revision: string; digest: string }, input: JsonValue) {
    return this.manager.startRun({ planPin: plan, input });
  }

  snapshot(runId: string): RunSnapshot | undefined {
    return this.snapshots.get(runId);
  }

  latestSnapshot(): RunSnapshot | undefined {
    return [...this.snapshots.values()].at(-1);
  }

  failNextLaunch(): void {
    this.dbos.launch.mockRejectedValueOnce(new Error('launch failed'));
  }

  failNextShutdown(): void {
    this.dbos.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
  }

  failNextSubmission(): void {
    this.dbos.failNextSubmission();
  }

  missNextAdmission(): void {
    this.dbos.missNextAdmission();
  }

  timeOutAdmission(): void {
    this.dbos.timeOutAdmission();
  }

  failProjection(status: RunSnapshot['status'], attempts: number): void {
    this.projectionFailures.set(status, attempts);
  }

  changeExecutorOutcomeDuringTerminalProjectionFailure(): void {
    this.changeOutcomeOnTerminalProjectionFailure = true;
  }

  executorFails(): void {
    this.executorOutcome = 'failed';
  }

  useInvalidPlan(): void {
    this.planSource = null;
  }

  executorCalls(): number {
    return this.executor.mock.calls.length;
  }

  configurationCalls(): readonly unknown[][] {
    return this.dbos.setConfig.mock.calls;
  }

  launchCalls(): number {
    return this.dbos.launch.mock.calls.length;
  }

  shutdownCalls(): number {
    return this.dbos.shutdown.mock.calls.length;
  }

  submittedWorkflowIds(runId: string): string[] {
    return this.dbos.ids.filter((id) => id === runId);
  }

  retryDelays(): number[] {
    return this.dbos.sleepms.mock.calls.map(([duration]) => duration);
  }

  resultMarker(): number {
    return this.dbos.results.length;
  }

  resultsSince(marker: number): Promise<unknown[]> {
    return Promise.all(this.dbos.results.slice(marker));
  }
}
