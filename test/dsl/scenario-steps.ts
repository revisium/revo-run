import type { ConsensusVote } from '../../src/contracts/pipeline/pipeline-progress.js';
import type { JsonValue, NodeOutput, OutputValue } from '../../src/index.js';
import { advanceLogicalTime } from './scenario-time.js';
import type { ExpectedRunEvent, ScenarioCommandRejectionReason, ScenarioStep } from './scenario.js';

export const startRun = (input: JsonValue = null): ScenarioStep => ({ kind: 'startRun', input });

export const startRunWithPlanSchemaVersion = (schemaVersion: number): ScenarioStep => ({
  kind: 'startRun',
  input: null,
  planSchemaVersionOverride: schemaVersion,
});

export const expectNodeExecutions = (...paths: readonly string[]): ScenarioStep => ({
  kind: 'expectNodeExecutions',
  paths,
});

export const expectAgentExecution = (path: string, roleId: string): ScenarioStep => ({
  kind: 'expectAgentExecution',
  path,
  roleId,
});

export const expectVersionedScriptExecution = (
  path: string,
  scriptId: string,
  revision: number,
): ScenarioStep => ({ kind: 'expectVersionedScriptExecution', path, scriptId, revision });

export const expectNodeInput = (path: string, value: JsonValue): ScenarioStep => ({
  kind: 'expectNodeInput',
  path,
  value,
});

export const expectRunDetails = (...nodePaths: readonly string[]): ScenarioStep => ({
  kind: 'expectRunDetails',
  nodePaths,
});

export const expectOutputValue = (
  path: string,
  outputKey: string,
  value: OutputValue,
): ScenarioStep => ({ kind: 'expectOutputValue', path, outputKey, value });

export const expectJsonOutput = (
  path: string,
  outputKey: string,
  value: JsonValue,
  pointer?: string,
): ScenarioStep => ({
  kind: 'expectJsonOutput',
  path,
  outputKey,
  value,
  ...(pointer === undefined ? {} : { pointer }),
});

export const completeNode = (
  path: string,
  outcome = 'completed',
  output?: JsonValue,
  attempt = 1,
): ScenarioStep => ({
  kind: 'completeNode',
  path,
  attempt,
  outcome,
  ...(output === undefined
    ? {}
    : {
        output: {
          result: { kind: 'json', value: output },
        },
      }),
});

export const completeNodeWithOutput = (
  path: string,
  outcome: string,
  output: NodeOutput,
  attempt = 1,
): ScenarioStep => ({ kind: 'completeNode', path, attempt, outcome, output });

export const failNode = (path: string, errorCode: string, attempt = 1): ScenarioStep => ({
  kind: 'failNode',
  path,
  attempt,
  errorCode,
});

export const expectRunStatus = (
  status: Extract<ScenarioStep, { kind: 'expectRunStatus' }>['status'],
): ScenarioStep => ({ kind: 'expectRunStatus', status });

export const expectEvent = (
  type: string,
  options: Omit<ExpectedRunEvent, 'type'> = {},
): ScenarioStep => ({ kind: 'expectEvent', event: { type, ...options } });

export const expectSecretResolved = (value: string): ScenarioStep => ({
  kind: 'expectSecretResolved',
  value,
});

export const answerGate = (
  path: string,
  answer: string,
  actorId: string,
  commandId: string,
  actorGroups: readonly string[] = [],
): ScenarioStep => ({
  kind: 'answerHumanGate',
  path,
  answer,
  actorId,
  actorGroups,
  commandId,
});

export const expectCommandAccepted = (commandId: string): ScenarioStep => ({
  kind: 'expectCommandResult',
  result: { status: 'accepted', commandId },
});

export const expectCommandRejected = (
  commandId: string,
  reason: ScenarioCommandRejectionReason,
): ScenarioStep => ({
  kind: 'expectCommandResult',
  result: { status: 'rejected', commandId, reason },
});

export const vote = (
  path: string,
  participantId: string,
  value: ConsensusVote['vote'],
  executionId: string,
): ScenarioStep => ({
  kind: 'completeConsensusParticipant',
  vote: { nodePath: path, participantId, vote: value, executionId },
});

export const advanceTime = (durationMs: number): ScenarioStep => {
  advanceLogicalTime(0, durationMs);
  return { kind: 'advanceTime', durationMs };
};
