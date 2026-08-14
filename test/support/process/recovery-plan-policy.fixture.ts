export const recoveryPolicies = {
  defaultTaskTimeoutMs: 60_000,
  maximumActiveNodeExecutions: 1,
  maximumNodeNestingDepth: 4,
  maximumSubpipelineDepth: 1,
  maximumTotalNodeExecutions: 2,
} as const;

export const recoverAbsentEffect = {
  reconciliation: 'required',
  maximumAttempts: 1,
  timeoutMs: 1_000,
  unknownOutcome: 'fail',
} as const;
