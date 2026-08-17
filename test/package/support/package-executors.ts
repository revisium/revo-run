import type {
  RunExecutor,
  RunExecutorContext,
  RunExecutorRequest,
  RunExecutorResult,
} from '../../../src/index.js';

export const completingExecutor: RunExecutor = {
  async execute(): Promise<RunExecutorResult> {
    return { kind: 'completed', outcome: 'completed' };
  },
};

export const createClassifyExecutor = (risk: string): RunExecutor => ({
  async execute(request: RunExecutorRequest): Promise<RunExecutorResult> {
    if (request.displayPath.endsWith('/classify') || request.displayPath === 'classify') {
      return {
        kind: 'completed',
        outcome: 'completed',
        output: { result: { kind: 'json', value: { risk } } },
      };
    }
    return { kind: 'completed', outcome: 'completed' };
  },
});

export const approvingParticipantExecutor: RunExecutor = {
  async execute(request: RunExecutorRequest): Promise<RunExecutorResult> {
    const separator = request.displayPath.lastIndexOf('/');
    const participantId = request.displayPath.slice(separator + 1);
    const nodePath = request.displayPath.slice(0, separator);
    return {
      kind: 'completed',
      outcome: 'approve',
      output: {
        vote: {
          kind: 'json',
          value: {
            nodePath,
            participantId,
            vote: 'approve',
            executionId: request.attemptId,
          },
        },
      },
    };
  },
};

export const unknownOutcomeExecutor: RunExecutor = {
  async execute(
    _request: RunExecutorRequest,
    context: RunExecutorContext,
  ): Promise<RunExecutorResult> {
    return new Promise((_resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('Executor aborted.'));
        return;
      }
      context.signal.addEventListener(
        'abort',
        () => {
          reject(new Error('Executor aborted.'));
        },
        { once: true },
      );
    });
  },
  async reconcile() {
    return { kind: 'outcomeUnknown' };
  },
};

export class HoldingExecutor implements RunExecutor {
  private readonly started = Promise.withResolvers<void>();

  whenStarted(): Promise<void> {
    return this.started.promise;
  }

  execute(_request: RunExecutorRequest, context: RunExecutorContext): Promise<RunExecutorResult> {
    this.started.resolve();
    return new Promise((_resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('Executor aborted.'));
        return;
      }
      context.signal.addEventListener(
        'abort',
        () => {
          reject(new Error('Executor aborted.'));
        },
        { once: true },
      );
    });
  }
}
