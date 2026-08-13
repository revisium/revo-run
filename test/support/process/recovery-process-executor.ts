import type {
  NodeOutput,
  RunExecutor,
  RunExecutorContext,
  RunExecutorRequest,
  RunExecutorReconciliationResult,
  RunExecutorResult,
} from '../../../src/index.js';
import type { RecoveryInstruction } from './effect-recovery-scenario-program.js';

type Report = (message: object) => void;

export interface RecoveryProcessExecutorOptions {
  readonly holdReconciliation: boolean;
  readonly ignoreAbort: boolean;
  readonly instructions: readonly RecoveryInstruction[];
  readonly instructionsConfigured: boolean;
  readonly report: Report;
  readonly scenario: string;
}

export class RecoveryProcessExecutor implements RunExecutor {
  private readonly pending = new Map<
    string,
    Array<{
      readonly reject: (error: unknown) => void;
      readonly resolve: (result: RunExecutorResult) => void;
    }>
  >();
  private readonly holdReconciliation: boolean;
  private readonly ignoreAbort: boolean;
  private readonly instructions: RecoveryInstruction[];
  private readonly instructionsConfigured: boolean;
  private readonly report: Report;
  private readonly scenario: string;

  constructor(options: RecoveryProcessExecutorOptions) {
    this.scenario = options.scenario;
    this.instructions = [...options.instructions];
    this.instructionsConfigured = options.instructionsConfigured;
    this.holdReconciliation = options.holdReconciliation;
    this.ignoreAbort = options.ignoreAbort;
    this.report = options.report;
  }

  execute(request: RunExecutorRequest, context: RunExecutorContext): Promise<RunExecutorResult> {
    this.report({
      kind: 'dispatched',
      path: request.displayPath,
      attemptId: request.attemptId,
      attemptOrdinal: request.attemptOrdinal,
      nodeInstanceId: request.nodeInstanceId,
    });
    if (this.scenario === 'retry' && request.attemptOrdinal === 1) {
      return Promise.resolve({
        kind: 'failed',
        error: { code: 'rate_limited', message: 'retry later' },
      });
    }
    if (this.scenario === 'timeout' && request.displayPath === 'main/work') {
      return new Promise(() => {
        context.signal.addEventListener('abort', () => {
          this.report({ kind: 'timeoutSignalled', path: request.displayPath });
        });
      });
    }

    return new Promise((resolve, reject) => {
      const pending = this.pending.get(request.displayPath) ?? [];
      const execution = { resolve, reject };
      pending.push(execution);
      this.pending.set(request.displayPath, pending);
      context.signal.addEventListener(
        'abort',
        () => {
          const index = pending.indexOf(execution);
          if (index >= 0) {
            pending.splice(index, 1);
          }
          this.report({ kind: 'executorAborted', path: request.displayPath });
          if (this.ignoreAbort) {
            return;
          }
          reject(context.signal.reason);
        },
        { once: true },
      );
    });
  }

  reconcile(
    request: RunExecutorRequest,
    attemptId: string,
  ): Promise<RunExecutorReconciliationResult> {
    if (attemptId !== request.attemptId) {
      throw new Error('Reconciliation received another attempt identity.');
    }
    this.report({
      kind: 'reconciled',
      path: request.displayPath,
      attemptId,
      attemptOrdinal: request.attemptOrdinal,
    });
    if (this.holdReconciliation) {
      return new Promise(() => undefined);
    }
    const instruction = this.instructions.shift();
    if (instruction === undefined) {
      if (this.instructionsConfigured) {
        throw new Error('No declared reconciliation instruction remains.');
      }
      return Promise.resolve({ kind: 'effectNotFound' });
    }
    switch (instruction.kind) {
      case 'effectCompleted':
        return Promise.resolve({
          kind: 'effectCompleted',
          result: {
            kind: 'completed',
            outcome: 'completed',
            ...(instruction.output === undefined ? {} : { output: instruction.output }),
          },
        });
      case 'effectFailed':
        return Promise.resolve({
          kind: 'effectFailed',
          error: { code: 'provider_failed', message: 'Provider reported a failed effect.' },
        });
      case 'effectNotFound':
        return Promise.resolve({ kind: 'effectNotFound' });
      case 'outcomeUnknown':
        return Promise.resolve({ kind: 'outcomeUnknown' });
      case 'reconciliationFailed':
        return Promise.reject(new Error('Reconciliation unavailable.'));
    }
    throw new Error('Recovery instruction is unsupported.');
  }

  complete(path: string, result: { readonly outcome: string; readonly output?: NodeOutput }): void {
    const execution = this.pending.get(path)?.shift();
    if (execution === undefined) {
      throw new Error(`Execution ${path} is not pending.`);
    }
    execution.resolve({ kind: 'completed', ...result });
  }
}
