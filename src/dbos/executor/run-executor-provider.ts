import type {
  RunExecutor,
  RunExecutorContext,
  RunExecutorRequest,
  RunExecutorResult,
} from '../../contracts/executor/run-executor.js';

export class RunExecutorProvider {
  private executor: RunExecutor | undefined;

  bind(executor: RunExecutor): () => void {
    if (this.executor !== undefined) {
      throw new Error('A run executor is already bound.');
    }

    this.executor = executor;
    return () => {
      if (this.executor === executor) {
        this.executor = undefined;
      }
    };
  }

  async execute(
    request: RunExecutorRequest,
    context: RunExecutorContext,
  ): Promise<RunExecutorResult> {
    if (this.executor === undefined) {
      throw new Error('Run executor is not bound.');
    }

    return this.executor.execute(request, context);
  }
}
