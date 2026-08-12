export const runWorkflowName = 'revo-run.run.v1';
export const runExecutionWorkflowName = 'revo-run.execution.v1';
export const parallelBranchWorkflowName = 'revo-run.parallel-branch.v1';
export const runEventStreamName = 'revo-run.events';
export const runCoordinatorMessageTopic = 'revo-run.coordinator';
export const runCoordinatorReplyTopic = 'revo-run.coordinator.reply';

const nodeExecutionStepPrefix = 'execute-node-attempt:';

export interface NodeExecutionStepIdentity {
  readonly attemptOrdinal: number;
  readonly displayPath: string;
}

const assertAttemptOrdinal = (attemptOrdinal: number): void => {
  if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1) {
    throw new RangeError('Node execution attempt ordinal must be a positive safe integer.');
  }
};

export const nodeExecutionStepName = (path: string, attemptOrdinal: number): string => {
  assertAttemptOrdinal(attemptOrdinal);
  return `${nodeExecutionStepPrefix}${attemptOrdinal}:${path}`;
};

export const isNodeExecutionStepName = (name: string): boolean =>
  name.startsWith(nodeExecutionStepPrefix);

export const nodeExecutionStepIdentity = (name: string): NodeExecutionStepIdentity => {
  if (!isNodeExecutionStepName(name)) {
    throw new Error('DBOS step is not a node execution.');
  }
  const identity = name.slice(nodeExecutionStepPrefix.length);
  const separator = identity.indexOf(':');
  if (separator < 1) {
    throw new Error('DBOS node execution step identity is invalid.');
  }
  const ordinalText = identity.slice(0, separator);
  const displayPath = identity.slice(separator + 1);
  if (!/^[1-9]\d*$/.test(ordinalText) || displayPath.length === 0) {
    throw new Error('DBOS node execution step identity is invalid.');
  }
  const attemptOrdinal = Number(ordinalText);
  if (!Number.isSafeInteger(attemptOrdinal)) {
    throw new TypeError('DBOS node execution step identity is invalid.');
  }
  return { attemptOrdinal, displayPath };
};
