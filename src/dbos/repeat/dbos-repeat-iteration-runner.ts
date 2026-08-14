import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RepeatIterationWorkflowInput } from '../../contracts/workflow/repeat-iteration-workflow-input.js';
import {
  createAuthoredNodeId,
  createRepeatIterationScopeId,
} from '../../pipeline/identity/execution-identity.js';
import { runtimePath } from '../../pipeline/interpreter/node-path.js';
import type {
  RepeatIterationExecution,
  RepeatIterationExecutionResult,
  RepeatIterationRunner,
} from '../../pipeline/repeat/repeat-iteration-runner.js';
import { parseRepeatIterationResult } from '../../validation/repeat-iteration-result.validator.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type { RepeatIterationWorkflowProvider } from '../workflows/repeat-iteration-workflow-provider.js';

export class DbosRepeatIterationRunner implements RepeatIterationRunner {
  constructor(
    private readonly workflows: RepeatIterationWorkflowProvider,
    private readonly coordinator: RunCoordinatorClient,
  ) {}

  async execute(input: RepeatIterationExecution): Promise<RepeatIterationExecutionResult> {
    await this.coordinator.boundary();
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: input.context.plan.schemaVersion,
      pipelineId: input.context.pipelineId,
      nodePath: input.nodePath,
      nodeKind: 'repeat',
    });
    const scopeId = createRepeatIterationScopeId({
      parentScopeId: input.context.scopeId,
      authoredNodeId,
      iterationOrdinal: input.ordinal,
    });
    const parentWorkflowId = DBOS.workflowID;
    if (!parentWorkflowId?.startsWith('rr:scope:')) {
      throw new Error('Repeat iteration parent has no workflow ID.');
    }
    const workflowId = scopeWorkflowId(scopeId);
    const startFence = await this.coordinator.admitScope(workflowId);
    const durableInput: RepeatIterationWorkflowInput = {
      runId: input.context.runId,
      scopeId,
      parentScopeId: input.context.scopeId,
      ordinal: input.ordinal,
      node: input.node.body,
      pipelineId: input.context.pipelineId,
      pipelineInput: input.context.pipelineInput,
      iterationInput: input.input,
      runtimePath: `${runtimePath(input.context, input.nodePath)}[${input.ordinal}]`,
      parentPath: input.nodePath,
      inheritedOutputs: [...input.context.outputs].map(([path, output]) => ({ path, output })),
      maximumParallelism: input.context.maximumParallelism,
      parentWorkflowId,
      startFence,
    };
    const handle = await DBOS.startWorkflow(this.workflows.get(), {
      workflowID: workflowId,
    })(durableInput);
    if (handle.workflowID !== workflowId) {
      throw new Error('Repeat iteration started with an unexpected workflow ID.');
    }
    const result = parseRepeatIterationResult(await handle.getResult());
    if (result.ordinal !== input.ordinal) {
      throw new Error('Repeat iteration returned another ordinal.');
    }
    return result;
  }
}
