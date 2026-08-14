export const runWorkflowName = 'revo-run.run';
export const runExecutionWorkflowName = 'revo-run.execution';
export const parallelBranchWorkflowName = 'revo-run.parallel-branch';
export const commandDispatchWorkflowName = 'revo-run.command-dispatch';
export const runEventStreamName = 'revo-run.events';
export const runCoordinatorReplyTopic = 'revo-run.coordinator.reply';
export const runCoordinatorTopic = 'revo-run.coordinator';
export const commandReplyTopic = 'revo-run.command.reply';
export const scopeDirectiveTopic = 'revo-run.scope-command';
export const scopeReplyTopic = 'revo-run.scope-command.reply';
export const scopeSettlementTopic = 'revo-run.scope-settlement';
export const scopeAdmissionReplyTopic = (workflowId: string): string =>
  `revo-run.scope-admission.reply:${workflowId}`;
export const unknownResolutionTopic = (attemptId: string): string =>
  `revo-run.unknown-resolution:${attemptId}`;

const runCommandDecisionStepPrefix = 'run-command-decision:';
const unknownOutcomeResolutionStepPrefix = 'unknown-outcome-resolution:';
const unknownOutcomeReadyStepPrefix = 'unknown-outcome-ready:';
const retryBackoffStepPrefix = 'retry-backoff:';
const parallelJoinDecisionStepPrefix = 'parallel-join-decision:';

export const runCommandDecisionStepName = (commandId: string): string =>
  `${runCommandDecisionStepPrefix}${commandId}`;

export const isRunCommandDecisionStepName = (name: string): boolean =>
  /^run-command-decision:cmd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    name,
  );

export const runCommandDecisionCommandId = (name: string): string => {
  if (!isRunCommandDecisionStepName(name)) {
    throw new Error('DBOS step is not a run command decision.');
  }
  return name.slice(runCommandDecisionStepPrefix.length);
};

export const unknownOutcomeReadyStepName = (attemptId: string): string =>
  `${unknownOutcomeReadyStepPrefix}${attemptId}`;

export const isUnknownOutcomeReadyStepName = (name: string): boolean =>
  name.startsWith(unknownOutcomeReadyStepPrefix);

export const unknownOutcomeReadyAttemptId = (name: string): string => {
  if (!isUnknownOutcomeReadyStepName(name)) {
    throw new Error('DBOS step is not an unknown-outcome readiness checkpoint.');
  }
  return name.slice(unknownOutcomeReadyStepPrefix.length);
};

export const unknownOutcomeResolutionStepName = (attemptId: string): string =>
  `${unknownOutcomeResolutionStepPrefix}${attemptId}`;

export const retryBackoffStepName = (attemptId: string): string =>
  `${retryBackoffStepPrefix}${attemptId}`;

export const parallelJoinDecisionStepName = (displayPath: string): string =>
  `${parallelJoinDecisionStepPrefix}${displayPath}`;

export const isParallelJoinDecisionStepName = (name: string): boolean =>
  name.startsWith(parallelJoinDecisionStepPrefix);

export const parallelJoinDecisionDisplayPath = (name: string): string => {
  if (!isParallelJoinDecisionStepName(name)) {
    throw new Error('DBOS step is not a parallel join decision.');
  }
  return name.slice(parallelJoinDecisionStepPrefix.length);
};

export const isRetryBackoffStepName = (name: string): boolean =>
  name.startsWith(retryBackoffStepPrefix);

export const isUnknownOutcomeResolutionStepName = (name: string): boolean =>
  name.startsWith(unknownOutcomeResolutionStepPrefix);

const nodeEffectIntentStepPrefix = 'node-effect-intent:';
const nodeEffectDecisionStepPrefix = 'node-effect-decision:';
const nodeEffectSelectionStepPrefix = 'node-effect-selection:';
const nodeReconciliationStepPrefix = 'node-effect-reconcile:';
const nodeReconciliationFailureStepPrefix = 'node-effect-reconcile-failed:';
const nodeReconciliationOutcomeStepPrefix = 'node-effect-reconcile-outcome:';

export interface NodeExecutionStepIdentity {
  readonly attemptOrdinal: number;
  readonly displayPath: string;
}

export interface NodeReconciliationStepIdentity extends NodeExecutionStepIdentity {
  readonly reconciliationRound: number;
}

const assertAttemptOrdinal = (attemptOrdinal: number): void => {
  if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1) {
    throw new RangeError('Node execution attempt ordinal must be a positive safe integer.');
  }
};

const nodeAttemptStepName = (prefix: string, path: string, attemptOrdinal: number): string => {
  assertAttemptOrdinal(attemptOrdinal);
  return `${prefix}${attemptOrdinal}:${path}`;
};

export const nodeEffectIntentStepName = (path: string, attemptOrdinal: number): string =>
  nodeAttemptStepName(nodeEffectIntentStepPrefix, path, attemptOrdinal);

export const nodeEffectDecisionStepName = (path: string, attemptOrdinal: number): string =>
  nodeAttemptStepName(nodeEffectDecisionStepPrefix, path, attemptOrdinal);

export const nodeEffectSelectionStepName = (path: string, attemptOrdinal: number): string =>
  nodeAttemptStepName(nodeEffectSelectionStepPrefix, path, attemptOrdinal);

const reconciliationStepName = (
  prefix: string,
  path: string,
  attemptOrdinal: number,
  reconciliationRound: number,
): string => {
  assertAttemptOrdinal(attemptOrdinal);
  assertAttemptOrdinal(reconciliationRound);
  return `${prefix}${attemptOrdinal}:${reconciliationRound}:${path}`;
};

export const nodeReconciliationStepName = (
  path: string,
  attemptOrdinal: number,
  reconciliationRound: number,
): string => {
  return reconciliationStepName(
    nodeReconciliationStepPrefix,
    path,
    attemptOrdinal,
    reconciliationRound,
  );
};

export const nodeReconciliationFailureStepName = (
  path: string,
  attemptOrdinal: number,
  reconciliationRound: number,
): string =>
  reconciliationStepName(
    nodeReconciliationFailureStepPrefix,
    path,
    attemptOrdinal,
    reconciliationRound,
  );

export const nodeReconciliationOutcomeStepName = (
  path: string,
  attemptOrdinal: number,
  reconciliationRound: number,
): string =>
  reconciliationStepName(
    nodeReconciliationOutcomeStepPrefix,
    path,
    attemptOrdinal,
    reconciliationRound,
  );

export const isNodeAttemptOutcomeStepName = (name: string): boolean =>
  name.startsWith(nodeEffectDecisionStepPrefix) ||
  name.startsWith(nodeReconciliationStepPrefix) ||
  name.startsWith(nodeReconciliationFailureStepPrefix) ||
  name.startsWith(nodeReconciliationOutcomeStepPrefix);

export const isNodeEffectIntentStepName = (name: string): boolean =>
  name.startsWith(nodeEffectIntentStepPrefix);

export const isNodeEffectDecisionStepName = (name: string): boolean =>
  name.startsWith(nodeEffectDecisionStepPrefix);

export const isNodeReconciliationStepName = (name: string): boolean =>
  name.startsWith(nodeReconciliationStepPrefix) ||
  name.startsWith(nodeReconciliationFailureStepPrefix) ||
  name.startsWith(nodeReconciliationOutcomeStepPrefix);

const reconciliationPrefix = (name: string): string | undefined =>
  [
    nodeReconciliationStepPrefix,
    nodeReconciliationFailureStepPrefix,
    nodeReconciliationOutcomeStepPrefix,
  ].find((prefix) => name.startsWith(prefix));

export const nodeReconciliationStepIdentity = (name: string): NodeReconciliationStepIdentity => {
  const prefix = reconciliationPrefix(name);
  if (prefix === undefined) {
    throw new Error('DBOS step is not a node reconciliation.');
  }
  const identity = name.slice(prefix.length);
  const attemptSeparator = identity.indexOf(':');
  const roundSeparator = identity.indexOf(':', attemptSeparator + 1);
  if (attemptSeparator < 1 || roundSeparator < attemptSeparator + 2) {
    throw new Error('DBOS node reconciliation step identity is invalid.');
  }
  const attemptOrdinalText = identity.slice(0, attemptSeparator);
  const reconciliationRoundText = identity.slice(attemptSeparator + 1, roundSeparator);
  const displayPath = identity.slice(roundSeparator + 1);
  if (
    !/^[1-9]\d*$/.test(attemptOrdinalText) ||
    !/^[1-9]\d*$/.test(reconciliationRoundText) ||
    displayPath.length === 0
  ) {
    throw new Error('DBOS node reconciliation step identity is invalid.');
  }
  const attemptOrdinal = Number(attemptOrdinalText);
  const reconciliationRound = Number(reconciliationRoundText);
  if (!Number.isSafeInteger(attemptOrdinal) || !Number.isSafeInteger(reconciliationRound)) {
    throw new TypeError('DBOS node reconciliation step identity is invalid.');
  }
  return { attemptOrdinal, reconciliationRound, displayPath };
};

const attemptIdentity = (name: string): string => {
  if (name.startsWith(nodeEffectIntentStepPrefix)) {
    return name.slice(nodeEffectIntentStepPrefix.length);
  }
  if (name.startsWith(nodeEffectDecisionStepPrefix)) {
    return name.slice(nodeEffectDecisionStepPrefix.length);
  }
  if (isNodeReconciliationStepName(name)) {
    const identity = nodeReconciliationStepIdentity(name);
    return `${identity.attemptOrdinal}:${identity.displayPath}`;
  }
  throw new Error('DBOS step is not a node attempt outcome.');
};

export const nodeAttemptStepIdentity = (name: string): NodeExecutionStepIdentity => {
  const identity = attemptIdentity(name);
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
