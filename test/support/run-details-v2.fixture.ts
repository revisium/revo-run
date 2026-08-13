import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import {
  nodeReconciliationOutcomeStepName,
  parallelBranchWorkflowName,
  parallelBranchWorkflowV2Name,
  runCommandDecisionStepName,
  runExecutionWorkflowName,
  runExecutionWorkflowV2Name,
  unknownOutcomeReadyStepName,
  unknownOutcomeResolutionStepName,
} from '../../src/dbos/dbos-names.js';
import { runWorkflowId, scopeWorkflowV2Id } from '../../src/dbos/workflow-id.js';
import type { RunSnapshot } from '../../src/index.js';
import {
  rootScope,
  runDetailsStatuses,
  runDetailsSteps,
  snapshot,
  step,
  storedNodeExecution,
  type TestStepInfo,
} from './run-details.fixture.js';

const commandId = 'cmd_00000000-0000-4000-8000-000000000000' as const;

const v2Statuses = (): Map<string, WorkflowStatus> => {
  const statuses = new Map<string, WorkflowStatus>();
  for (const [id, value] of runDetailsStatuses()) {
    const workflowID = id.replace('rr:scope:v1:', 'rr:scope:v2:');
    const root = value.workflowName === runExecutionWorkflowName;
    if (!Array.isArray(value.input) || value.input.length !== 1) {
      throw new Error('V1 scope fixture input is missing.');
    }
    const branchInput = value.input[0];
    if (typeof branchInput !== 'object' || branchInput === null || Array.isArray(branchInput)) {
      throw new Error('V1 branch fixture input is invalid.');
    }
    if (typeof value.output !== 'object' || value.output === null || Array.isArray(value.output)) {
      throw new Error('V1 scope fixture output is invalid.');
    }
    const parentWorkflowID = value.parentWorkflowID?.replace('rr:scope:v1:', 'rr:scope:v2:');
    statuses.set(workflowID, {
      ...value,
      workflowID,
      workflowName: root ? runExecutionWorkflowV2Name : parallelBranchWorkflowV2Name,
      ...(parentWorkflowID === undefined ? {} : { parentWorkflowID }),
      input: root ? value.input : [{ ...branchInput, parentWorkflowId: parentWorkflowID }],
      output: root ? value.output : { status: 'completed', ...value.output },
    });
  }
  return statuses;
};

const v2Steps = (): Map<string, readonly TestStepInfo[]> => {
  const steps = new Map<string, readonly TestStepInfo[]>();
  for (const [id, values] of runDetailsSteps()) {
    const workflowID = id.replace('rr:scope:v1:', 'rr:scope:v2:');
    steps.set(
      workflowID,
      values.map((value) => ({
        ...value,
        name:
          value.name === runExecutionWorkflowName
            ? runExecutionWorkflowV2Name
            : value.name === parallelBranchWorkflowName
              ? parallelBranchWorkflowV2Name
              : value.name,
        childWorkflowID: value.childWorkflowID?.replace('rr:scope:v1:', 'rr:scope:v2:') ?? null,
      })),
    );
  }
  return steps;
};

export const runDetailsHumanResolutionFixture = () => {
  if (rootScope === undefined) {
    throw new Error('Root scope is missing.');
  }
  const rootNode = snapshot.executionPlan.pipelines.main?.root;
  const first = rootNode?.kind === 'sequence' ? rootNode.children[0] : undefined;
  if (rootNode?.kind !== 'sequence' || first?.kind !== 'task') {
    throw new Error('Root task fixture is missing.');
  }
  const humanResolutionSnapshot: RunSnapshot = {
    ...snapshot,
    executionPlan: {
      ...snapshot.executionPlan,
      pipelines: {
        ...snapshot.executionPlan.pipelines,
        main: {
          root: {
            ...rootNode,
            children: [
              {
                ...first,
                recovery: {
                  reconciliation: 'required',
                  maximumAttempts: 2,
                  timeoutMs: 1_000,
                  unknownOutcome: 'requireHumanResolution',
                },
              },
              ...rootNode.children.slice(1),
            ],
          },
        },
      },
    },
  };
  const request = storedNodeExecution('main/root-work', 'completed').request;
  const beforeReadySteps = v2Steps();
  beforeReadySteps.set(runWorkflowId(snapshot.id), [
    step(1, runExecutionWorkflowV2Name, {
      childWorkflowID: scopeWorkflowV2Id(rootScope.id),
    }),
    step(2, 'DBOS.getResult', { childWorkflowID: scopeWorkflowV2Id(rootScope.id) }),
  ]);
  beforeReadySteps.set(scopeWorkflowV2Id(rootScope.id), [
    step(1, nodeReconciliationOutcomeStepName('main/root-work', 1, 1), {
      output: {
        kind: 'runNodeReconciliation',
        request,
        reconciliationRound: 1,
        result: { kind: 'outcomeUnknown' },
      },
    }),
  ]);

  const acceptedAdoptionSteps = new Map(beforeReadySteps);
  acceptedAdoptionSteps.set(runWorkflowId(snapshot.id), [
    step(1, runExecutionWorkflowV2Name, {
      childWorkflowID: scopeWorkflowV2Id(rootScope.id),
    }),
    step(2, runCommandDecisionStepName(commandId), {
      output: {
        commandId,
        commandKind: 'resolveUnknownOutcome',
        actorId: 'release-manager',
        decision: 'accepted',
        attemptId: request.attemptId,
        resolutionKind: 'adoptSuccess',
        outcome: 'published',
      },
    }),
    step(3, 'DBOS.getResult', { childWorkflowID: scopeWorkflowV2Id(rootScope.id) }),
  ]);
  acceptedAdoptionSteps.set(scopeWorkflowV2Id(rootScope.id), [
    step(1, nodeReconciliationOutcomeStepName('main/root-work', 1, 1), {
      output: {
        kind: 'runNodeReconciliation',
        request,
        reconciliationRound: 1,
        result: { kind: 'outcomeUnknown' },
      },
    }),
    step(2, unknownOutcomeReadyStepName(request.attemptId), { output: request.attemptId }),
    step(3, unknownOutcomeResolutionStepName(request.attemptId), {
      output: {
        kind: 'adoptSuccess',
        commandId,
        outcome: 'published',
        output: { release: { kind: 'json', value: 'ok' } },
      },
    }),
    ...(beforeReadySteps.get(scopeWorkflowV2Id(rootScope.id)) ?? []).filter(
      ({ functionID }) => functionID > 3,
    ),
  ]);

  return {
    acceptedAdoptionSteps,
    beforeReadySteps,
    commandId,
    request,
    snapshot: humanResolutionSnapshot,
    statuses: v2Statuses(),
  };
};
