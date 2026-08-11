import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunNodeExecution } from '../../contracts/executor/run-node-execution.js';
import { RunExecutorResultValidator } from '../../validation/run-executor-result.validator.js';
import { nodeExecutionStepName } from '../dbos-names.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { isDbosStepTimeout } from './step-timeout.js';

export class NodeExecutionStep {
  private readonly executor: RunExecutorProvider;

  constructor(executor: RunExecutorProvider) {
    this.executor = executor;
  }

  async execute(
    request: RunExecutorRequest,
    timeoutMs: number,
  ): Promise<RunNodeExecution | { readonly kind: 'timedOut' }> {
    try {
      return await DBOS.runStep(
        async () => {
          const signal = DBOS.stepStatus?.timeoutSignal;
          if (signal === undefined) {
            throw new Error('DBOS did not provide a step timeout signal.');
          }

          const result = await this.executor.execute(request, { signal });
          if (!RunExecutorResultValidator.Check(result)) {
            throw new Error('Run executor returned an invalid result.');
          }

          return { kind: 'runNodeExecution', request, result };
        },
        {
          name: nodeExecutionStepName(request.displayPath),
          retriesAllowed: false,
          timeoutMS: timeoutMs,
        },
      );
    } catch (error) {
      if (isDbosStepTimeout(error)) {
        return { kind: 'timedOut' };
      }
      throw error;
    }
  }
}
