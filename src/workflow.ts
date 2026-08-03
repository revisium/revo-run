import { DBOS } from '@dbos-inc/dbos-sdk';

import { childWorkflowId, interpretPipeline } from './pipeline.js';
import type { CreateRunManagerOptions, JsonValue, RunSnapshot } from './types.js';

const APPLICATION_NAME = 'revo-run';
const RUN_WORKFLOW_NAME = 'revo-run.run.v1';
const TASK_WORKFLOW_NAME = 'revo-run.task.v1';
const CANDIDATE_WORKFLOW_NAME = 'revo-run.candidate.v1';

export const createWorkflowRuntime = (dependencies: CreateRunManagerOptions) => {
  const waitForAdmission = async (runId: string): Promise<RunSnapshot> => {
    const acknowledged = await DBOS.getEvent<RunSnapshot>(runId, 'created', {
      timeoutSeconds: 60,
    });
    return acknowledged ?? waitForAdmission(runId);
  };
  const project = async (snapshot: RunSnapshot, attempt = 0): Promise<void> => {
    const delivered = await DBOS.runStep(
      async () => {
        try {
          if (snapshot.status === 'pending') await dependencies.snapshots.create(snapshot);
          else await dependencies.snapshots.update(snapshot);
          return true;
        } catch {
          return false;
        }
      },
      { name: `project-${snapshot.status}` },
    );
    if (delivered) return;
    await DBOS.sleepms(Math.min(100 * 2 ** Math.min(attempt, 6), 5_000));
    return project(snapshot, attempt + 1);
  };
  const task = DBOS.registerWorkflow(
    async (runId: string, nodeKey: string, input: JsonValue) =>
      (
        await DBOS.runStep(() => dependencies.executor.execute({ runId, nodeKey, input }), {
          name: 'execute',
        })
      ).outcome,
    { name: TASK_WORKFLOW_NAME },
  );
  const candidate = DBOS.registerWorkflow(
    async (runId: string, nodeKey: string, name: string, input: JsonValue) =>
      (
        await DBOS.runStep(
          () => dependencies.executor.execute({ runId, nodeKey, candidate: name, input }),
          { name: 'execute' },
        )
      ).outcome === 'completed'
        ? ('approve' as const)
        : ('reject' as const),
    { name: CANDIDATE_WORKFLOW_NAME },
  );
  const run = DBOS.registerWorkflow(
    async (created: RunSnapshot): Promise<RunSnapshot> => {
      await DBOS.setEvent('created', created);
      await project(created);
      const running: RunSnapshot = { ...created, status: 'running' };
      await project(running);
      let terminal: RunSnapshot;
      try {
        const plan = await DBOS.runStep(() => dependencies.plans.loadExact(created.planPin), {
          name: 'load-plan',
        });
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
        const succeeded = result.outcome === 'succeeded';
        terminal = {
          ...running,
          status: succeeded ? 'succeeded' : 'failed',
          result: result,
          error: succeeded ? null : `Pipeline terminated with outcome ${result.outcome}.`,
        };
      } catch (error: unknown) {
        terminal = {
          ...running,
          status: 'failed',
          result: null,
          error: error instanceof Error ? error.message : 'Run execution failed.',
        };
      }
      await project(terminal);
      return terminal;
    },
    { name: RUN_WORKFLOW_NAME },
  );

  return {
    configure: () =>
      DBOS.setConfig({ name: APPLICATION_NAME, systemDatabaseUrl: dependencies.database.url }),
    launch: () => DBOS.launch(),
    shutdown: () => DBOS.shutdown(),
    submit: async (snapshot: RunSnapshot) => {
      await DBOS.startWorkflow(run, { workflowID: snapshot.id })(snapshot);
      return waitForAdmission(snapshot.id);
    },
  };
};
