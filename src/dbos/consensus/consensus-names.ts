export const consensusParticipantWorkflowName = 'revo-run.consensus-participant';

export const consensusResolutionTopic = (nodeInstanceId: string): string =>
  `revo-run.consensus-resolution:${nodeInstanceId}`;

const consensusWaitingStepPrefix = 'consensus-waiting:';
const consensusVerdictStepPrefix = 'consensus-verdict:';

export const consensusWaitingStepName = (nodeInstanceId: string): string =>
  `${consensusWaitingStepPrefix}${nodeInstanceId}`;

export const isConsensusWaitingStepName = (name: string): boolean =>
  name.startsWith(consensusWaitingStepPrefix);

export const consensusWaitingNodeInstanceId = (name: string): string => {
  if (!isConsensusWaitingStepName(name)) {
    throw new Error('DBOS step is not a consensus waiting checkpoint.');
  }
  return name.slice(consensusWaitingStepPrefix.length);
};

export const consensusVerdictStepName = (nodeInstanceId: string): string =>
  `${consensusVerdictStepPrefix}${nodeInstanceId}`;

export const isConsensusVerdictStepName = (name: string): boolean =>
  name.startsWith(consensusVerdictStepPrefix);

export const consensusVerdictNodeInstanceId = (name: string): string => {
  if (!isConsensusVerdictStepName(name)) {
    throw new Error('DBOS step is not a consensus verdict checkpoint.');
  }
  return name.slice(consensusVerdictStepPrefix.length);
};
