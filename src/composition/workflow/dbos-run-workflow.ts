import { DBOS } from '@dbos-inc/dbos-sdk';

import {
  deriveChildWorkflowId,
  interpretPipeline,
  type PipelineExecution,
} from '../../lifecycle/pipeline-construction.js';
import type { RunManagerSnapshot } from '../../manager/index.js';
import type { JsonValue } from '../../spec/index.js';
import type { RunWorkflowDependencies } from './run-workflow-dependencies.js';
import type { RunWorkflowRuntime } from './run-workflow-runtime.js';

export const createDbosRunWorkflow = (
  name: string,
  dependencies: RunWorkflowDependencies,
): RunWorkflowRuntime => {
  const taskWorkflow = DBOS.registerWorkflow(
    async (runId: string, nodeKey: string, input: JsonValue): Promise<'completed' | 'failed'> => {
      const result = await DBOS.runStep(
        () => dependencies.executor.execute({ input, nodeKey, runId }),
        { name: 'execute' },
      );
      return result.outcome;
    },
    { name: `revoRun.${name}.task` },
  );
  const candidateWorkflow = DBOS.registerWorkflow(
    async (
      runId: string,
      nodeKey: string,
      candidate: string,
      input: JsonValue,
    ): Promise<'approve' | 'reject'> => {
      const result = await DBOS.runStep(
        () => dependencies.executor.execute({ candidate, input, nodeKey, runId }),
        { name: 'execute' },
      );
      return result.outcome === 'completed' ? 'approve' : 'reject';
    },
    { name: `revoRun.${name}.candidate` },
  );
  const workflow = DBOS.registerWorkflow(
    async (snapshot: RunManagerSnapshot): Promise<RunManagerSnapshot> => {
      await DBOS.runStep(() => dependencies.snapshots.create(snapshot), {
        name: 'project-created',
      });
      await DBOS.setEvent('created', snapshot);
      const running = { ...snapshot, status: 'running' as const };
      await DBOS.runStep(() => dependencies.snapshots.update(running), {
        name: 'project-running',
      });
      let terminalSnapshot: RunManagerSnapshot;
      try {
        const plan = await DBOS.runStep(() => dependencies.plans.loadExact(snapshot.planPin), {
          name: 'load-plan',
        });
        const execution: PipelineExecution = {
          executeCandidate: async (nodeKey, candidate) => {
            const handle = await DBOS.startWorkflow(candidateWorkflow, {
              workflowID: deriveChildWorkflowId(snapshot.id, 'candidate', nodeKey, candidate),
            })(snapshot.id, nodeKey, candidate, plan.taskInputs?.[nodeKey] ?? snapshot.input);
            return handle.getResult();
          },
          executeTask: async (nodeKey) => {
            const handle = await DBOS.startWorkflow(taskWorkflow, {
              workflowID: deriveChildWorkflowId(snapshot.id, 'task', nodeKey),
            })(snapshot.id, nodeKey, plan.taskInputs?.[nodeKey] ?? snapshot.input);
            return handle.getResult();
          },
        };
        const terminal = await interpretPipeline(plan.compiledPipeline, execution);
        const succeeded = terminal.outcome === 'succeeded';
        terminalSnapshot = {
          ...running,
          error: succeeded ? null : `Pipeline terminated with outcome ${terminal.outcome}.`,
          result: { outcome: terminal.outcome, terminalNode: terminal.terminalNode },
          status: succeeded ? 'succeeded' : 'failed',
        };
      } catch (error: unknown) {
        terminalSnapshot = {
          ...running,
          error: error instanceof Error ? error.message : 'Run execution failed.',
          result: null,
          status: 'failed',
        };
      }
      await DBOS.runStep(() => dependencies.snapshots.update(terminalSnapshot), {
        name: 'project-terminal',
      });
      return terminalSnapshot;
    },
    { name: `revoRun.${name}` },
  );

  return {
    configure: ({ applicationName, systemDatabaseUrl }) => {
      DBOS.setConfig({ name: applicationName, systemDatabaseUrl });
    },
    launch: () => DBOS.launch(),
    shutdown: () => DBOS.shutdown(),
    startRun: async (snapshot) => {
      await DBOS.startWorkflow(workflow, { workflowID: snapshot.id })(snapshot);
      const created = await DBOS.getEvent<RunManagerSnapshot>(snapshot.id, 'created', {
        timeoutSeconds: 10,
      });
      if (created === null) throw new Error('Timed out waiting for run creation acknowledgement.');
      return created;
    },
  };
};
