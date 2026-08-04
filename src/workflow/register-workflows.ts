import { DBOS } from '@dbos-inc/dbos-sdk';

import { childWorkflowId, interpretPipeline } from '../pipeline/interpret-pipeline.js';
import {
  createFailedSnapshot,
  createRunningSnapshot,
  createSucceededSnapshot,
} from '../snapshot/create-snapshot.js';
import type { JsonValue, RunSnapshot } from '../types.js';
import { getWorkflowDependencies } from './workflow-context.js';

const RUN_WORKFLOW_NAME = 'revo-run.run.v1';
const TASK_WORKFLOW_NAME = 'revo-run.task.v1';
const CANDIDATE_WORKFLOW_NAME = 'revo-run.candidate.v1';

const executeTask = (runId: string, nodeKey: string, input: JsonValue) =>
  DBOS.runStep(() => getWorkflowDependencies().executor.execute({ runId, nodeKey, input }), {
    name: 'execute',
  });

const executeCandidate = (runId: string, nodeKey: string, name: string, input: JsonValue) =>
  DBOS.runStep(
    () => getWorkflowDependencies().executor.execute({ runId, nodeKey, candidate: name, input }),
    { name: 'execute' },
  );

const loadPlan = (snapshot: RunSnapshot) =>
  DBOS.runStep(() => getWorkflowDependencies().plans.loadExact(snapshot.planPin), {
    name: 'load-plan',
  });

const projectSnapshot = async (snapshot: RunSnapshot): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    const snapshots = getWorkflowDependencies().snapshots;
    // oxlint-disable-next-line no-await-in-loop -- durable projection retries are sequential
    const delivered = await DBOS.runStep(
      async () => {
        try {
          if (snapshot.status === 'pending') {
            await snapshots.create(snapshot);
          } else {
            await snapshots.update(snapshot);
          }
          return true;
        } catch {
          return false;
        }
      },
      { name: `project-${snapshot.status}` },
    );
    if (delivered) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- each retry waits for its deterministic backoff
    await DBOS.sleepms(Math.min(100 * 2 ** Math.min(attempt, 6), 5_000));
  }
};

const taskWorkflow = async (runId: string, nodeKey: string, input: JsonValue) =>
  (await executeTask(runId, nodeKey, input)).outcome;

const candidateWorkflow = async (runId: string, nodeKey: string, name: string, input: JsonValue) =>
  (await executeCandidate(runId, nodeKey, name, input)).outcome === 'completed'
    ? 'approve'
    : 'reject';

const runWorkflow =
  (task: typeof taskWorkflow, candidate: typeof candidateWorkflow) =>
  async (created: RunSnapshot): Promise<RunSnapshot> => {
    await DBOS.setEvent('created', created);
    await projectSnapshot(created);

    const running = createRunningSnapshot(created);
    await projectSnapshot(running);

    let terminal: RunSnapshot;
    try {
      const plan = await loadPlan(created);
      const result = await interpretPipeline(plan.compiledPipeline, {
        executeTask: async (nodeKey) => {
          const handle = await DBOS.startWorkflow(task, {
            workflowID: childWorkflowId(created.id, 'task', nodeKey),
          })(created.id, nodeKey, plan.taskInputs?.[nodeKey] ?? created.input);
          return handle.getResult();
        },
        executeCandidate: async (nodeKey, candidateName) => {
          const handle = await DBOS.startWorkflow(candidate, {
            workflowID: childWorkflowId(created.id, 'candidate', nodeKey, candidateName),
          })(created.id, nodeKey, candidateName, plan.taskInputs?.[nodeKey] ?? created.input);
          return handle.getResult();
        },
      });
      terminal =
        result.outcome === 'succeeded'
          ? createSucceededSnapshot(running, result)
          : createFailedSnapshot(
              running,
              `Pipeline terminated with outcome ${result.outcome}.`,
              result,
            );
    } catch (error: unknown) {
      terminal = createFailedSnapshot(
        running,
        error instanceof Error ? error.message : 'Run execution failed.',
      );
    }

    await projectSnapshot(terminal);
    return terminal;
  };

export interface RegisteredWorkflows {
  readonly run: (snapshot: RunSnapshot) => Promise<RunSnapshot>;
}

let registeredWorkflows: RegisteredWorkflows | undefined;

export const registerWorkflows = (): RegisteredWorkflows => {
  if (registeredWorkflows) {
    return registeredWorkflows;
  }

  const task = DBOS.registerWorkflow(taskWorkflow, { name: TASK_WORKFLOW_NAME });
  const candidate = DBOS.registerWorkflow(candidateWorkflow, { name: CANDIDATE_WORKFLOW_NAME });
  const run = DBOS.registerWorkflow(runWorkflow(task, candidate), { name: RUN_WORKFLOW_NAME });
  registeredWorkflows = { run };
  return registeredWorkflows;
};
