export const humanGateResolutionTopic = (gateInstanceId: string): string =>
  `revo-run.human-gate-resolution:${gateInstanceId}`;

const humanGateWaitingStepPrefix = 'human-gate-waiting:';
const humanGateResolutionStepPrefix = 'human-gate-resolution:';

export const humanGateWaitingStepName = (gateInstanceId: string): string =>
  `${humanGateWaitingStepPrefix}${gateInstanceId}`;

export const isHumanGateWaitingStepName = (name: string): boolean =>
  name.startsWith(humanGateWaitingStepPrefix);

export const humanGateWaitingGateInstanceId = (name: string): string => {
  if (!isHumanGateWaitingStepName(name)) {
    throw new Error('DBOS step is not a human gate waiting checkpoint.');
  }
  return name.slice(humanGateWaitingStepPrefix.length);
};

export const humanGateResolutionStepName = (gateInstanceId: string): string =>
  `${humanGateResolutionStepPrefix}${gateInstanceId}`;

export const isHumanGateResolutionStepName = (name: string): boolean =>
  name.startsWith(humanGateResolutionStepPrefix);

export const humanGateResolutionGateInstanceId = (name: string): string => {
  if (!isHumanGateResolutionStepName(name)) {
    throw new Error('DBOS step is not a human gate resolution checkpoint.');
  }
  return name.slice(humanGateResolutionStepPrefix.length);
};
