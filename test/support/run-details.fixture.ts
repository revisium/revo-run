import { Error as DBOSError } from '@dbos-inc/dbos-sdk';
import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import {
  nodeExecutionStepName,
  parallelBranchWorkflowName,
  runExecutionWorkflowName,
} from '../../src/dbos/dbos-names.js';
import { buildObservablePlan } from '../../src/dbos/read-model/observable-plan.js';
import { runWorkflowId, scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import type { ExecutionPlan, RunSnapshot } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';

export interface TestStepInfo {
  readonly functionID: number;
  readonly name: string;
  readonly output: unknown;
  readonly error: Error | null;
  readonly childWorkflowID: string | null;
  readonly startedAtEpochMs?: number;
  readonly completedAtEpochMs?: number;
}

export const runId = 'Run_1';
const subpipeline = { kind: 'subpipeline', key: 'review', pipelineId: 'review' } as const;
const parallel = {
  kind: 'parallel',
  key: 'batch',
  branches: { a: task('a'), b: task('b') },
  join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
} as const;
export const plan: ExecutionPlan = executionPlan(
  sequence(task('root-work'), subpipeline, parallel, end('succeeded')),
  {
    pipelines: { review: task('check') },
    bindings: [
      agentBinding('root-work', 'worker'),
      agentBinding('check', 'reviewer', { pipelineId: 'review' }),
      agentBinding('batch/a', 'worker'),
      agentBinding('batch/b', 'worker'),
    ],
  },
);
export const observable = buildObservablePlan(plan, runId);
export const rootScope = observable.scopes.get(observable.rootScopeId);
export const branchScopes = [...observable.scopes.values()].filter(
  ({ kind }) => kind === 'parallelBranch',
);

export const snapshot: RunSnapshot = {
  id: runId,
  status: 'succeeded',
  result: { outcome: 'succeeded' },
  executionPlan: plan,
  input: null,
  createdAt: new Date(1),
  updatedAt: new Date(20),
};

export const workflowStatus = (
  workflowID: string,
  workflowName: string,
  input: unknown,
  parentWorkflowID: string,
  output: unknown,
): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 2,
  updatedAt: 19,
  completedAt: 18,
  input: [input],
  output,
  parentWorkflowID,
  priority: 0,
  status: 'SUCCESS',
  workflowClassName: '',
  workflowID,
  workflowName,
});

export const step = (
  functionID: number,
  name: string,
  options: {
    readonly childWorkflowID?: string;
    readonly error?: Error;
    readonly output?: unknown;
  } = {},
): TestStepInfo => ({
  functionID,
  name,
  output: options.output ?? null,
  error: options.error ?? null,
  childWorkflowID: options.childWorkflowID ?? null,
  startedAtEpochMs: 5 + functionID,
  completedAtEpochMs: 6 + functionID,
});

const execution = (path: string, kind: 'completed' | 'failed') => {
  const candidate = observable.nodesByDisplayPath.get(path);
  if (candidate === undefined) {
    throw new Error(`Missing candidate ${path}.`);
  }
  const binding = plan.bindings.find(
    ({ target }) =>
      target.pipelineId === candidate.pipelineId && target.nodePath === candidate.nodePath,
  );
  if (binding === undefined) {
    throw new Error(`Missing binding ${path}.`);
  }
  return {
    kind: 'runNodeExecution',
    request: {
      runId,
      authoredNodeId: candidate.authoredNodeId,
      scopeId: candidate.scopeId,
      nodeInstanceId: candidate.id,
      attemptId: candidate.attemptId,
      attemptOrdinal: 1,
      displayPath: candidate.displayPath,
      pipelineId: candidate.pipelineId,
      nodePath: candidate.nodePath,
      binding,
      input: {},
    },
    result:
      kind === 'completed'
        ? { kind: 'completed', outcome: 'completed' }
        : { kind: 'failed', error: { code: 'provider_failed', message: 'secret detail' } },
  };
};

export const runDetailsStatuses = (): Map<string, WorkflowStatus> => {
  if (rootScope === undefined || branchScopes.length !== 2) {
    throw new Error('Observable test plan is incomplete.');
  }
  return new Map([
    [
      scopeWorkflowId(rootScope.id),
      workflowStatus(
        scopeWorkflowId(rootScope.id),
        runExecutionWorkflowName,
        { runId, scopeId: rootScope.id },
        runWorkflowId(runId),
        { status: 'succeeded', outcome: 'succeeded' },
      ),
    ],
    ...branchScopes.map(
      (branch, index) =>
        [
          scopeWorkflowId(branch.id),
          workflowStatus(
            scopeWorkflowId(branch.id),
            parallelBranchWorkflowName,
            {
              runId,
              scopeId: branch.id,
              branchKey: index === 0 ? 'a' : 'b',
              node: index === 0 ? task('a') : task('b'),
              pipelineId: 'main',
              pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
              runtimePath: 'main',
              parentPath: 'batch',
              inheritedOutputs: [],
              maximumParallelism: 1,
            },
            scopeWorkflowId(rootScope.id),
            { key: index === 0 ? 'a' : 'b', outcome: 'completed', outputs: [] },
          ),
        ] as const,
    ),
  ]);
};

export const runDetailsSteps = (): Map<string, readonly TestStepInfo[]> => {
  const branchA = branchScopes[0];
  const branchB = branchScopes[1];
  if (rootScope === undefined || branchA === undefined || branchB === undefined) {
    throw new Error('Observable test scopes are incomplete.');
  }
  return new Map([
    [
      runWorkflowId(runId),
      [
        step(1, runExecutionWorkflowName, { childWorkflowID: scopeWorkflowId(rootScope.id) }),
        step(2, 'DBOS.getResult', { childWorkflowID: scopeWorkflowId(rootScope.id) }),
      ],
    ],
    [
      scopeWorkflowId(rootScope.id),
      [
        step(1, nodeExecutionStepName('main/root-work'), {
          output: execution('main/root-work', 'completed'),
        }),
        step(2, nodeExecutionStepName('main/review/check'), {
          output: execution('main/review/check', 'failed'),
        }),
        step(3, parallelBranchWorkflowName, { childWorkflowID: scopeWorkflowId(branchA.id) }),
        step(4, 'DBOS.getResult', { childWorkflowID: scopeWorkflowId(branchA.id) }),
        step(5, parallelBranchWorkflowName, { childWorkflowID: scopeWorkflowId(branchB.id) }),
        step(6, 'DBOS.getResult', { childWorkflowID: scopeWorkflowId(branchB.id) }),
      ],
    ],
    [
      scopeWorkflowId(branchA.id),
      [
        step(1, nodeExecutionStepName('main/batch/a'), {
          output: execution('main/batch/a', 'completed'),
        }),
      ],
    ],
    [
      scopeWorkflowId(branchB.id),
      [
        step(1, nodeExecutionStepName('main/batch/b'), {
          error: new DBOSError.DBOSStepTimeoutError('execute-node:main/batch/b', 10),
        }),
      ],
    ],
  ]);
};
