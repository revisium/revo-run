import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { TaskNode } from '../../contracts/pipeline/pipeline-node.js';
import { createAttemptId } from '../identity/execution-identity.js';
import type { PipelineExecutionContext, WaitForUnknownOutcome } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution, terminalExecution } from './pipeline-node-result.js';

type RetryUnknownOutcome = (
  nextAttemptOrdinal: number,
  nextReconciliationRound: number,
  permitCommandId: string,
) => Promise<NodeExecutionResult>;

type FailUnknownOutcome = (errorCode: string) => Promise<NodeExecutionResult>;

interface UnknownOutcomeResolutionContext {
  readonly waitForResolution: WaitForUnknownOutcome;
  readonly node: TaskNode;
  readonly context: PipelineExecutionContext;
  readonly nodePath: string;
  readonly request: RunExecutorRequest;
  readonly reconciliationRound: number;
  readonly fail: FailUnknownOutcome;
  readonly retry: RetryUnknownOutcome;
}

export const resolveUnknownOutcome = async ({
  waitForResolution,
  node,
  context,
  nodePath,
  request,
  reconciliationRound,
  fail,
  retry,
}: UnknownOutcomeResolutionContext): Promise<NodeExecutionResult> => {
  const recovery = node.recovery;
  if (
    recovery?.reconciliation !== 'required' ||
    recovery.unknownOutcome !== 'requireHumanResolution'
  ) {
    throw new Error('Task recovery does not permit human resolution.');
  }
  const resolution = await waitForResolution(request, recovery, node.retry, reconciliationRound);
  switch (resolution.kind) {
    case 'adoptSuccess': {
      const output = resolution.output;
      if (output !== undefined) {
        context.outputs.set(nodePath, output);
      }
      return continuedExecution(resolution.outcome, runtimePath(context, nodePath), output);
    }
    case 'markFailed':
      return fail(resolution.errorCode);
    case 'retry': {
      const nextAttemptOrdinal = request.attemptOrdinal + 1;
      const nextAttemptId = createAttemptId({
        nodeInstanceId: request.nodeInstanceId,
        attemptOrdinal: nextAttemptOrdinal,
      });
      if (resolution.attemptId !== nextAttemptId) {
        throw new Error('Unknown outcome retry permit has an invalid attempt identity.');
      }
      return retry(nextAttemptOrdinal, reconciliationRound + 1, resolution.commandId);
    }
    case 'cancel':
      return terminalExecution({ status: 'cancelled', outcome: 'cancelled' });
    case 'fail':
      return terminalExecution({ status: 'failed', outcome: 'failed' });
  }
  resolution satisfies never;
  throw new Error('Unknown outcome resolution is unsupported.');
};
