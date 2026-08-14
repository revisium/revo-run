import type { ExecuteNodeEffect } from './interpreter-context.js';
import type { PipelineEventSink } from './pipeline-event-sink.js';

/** Adds the public cancellation event at the task-effect boundary. */
export const withCancellationEvent =
  (executeEffect: ExecuteNodeEffect, events: PipelineEventSink): ExecuteNodeEffect =>
  async (...input) => {
    const result = await executeEffect(...input);
    if (result.kind === 'cancelled') {
      const request = input[0];
      await events.write({
        type: 'nodeExecution.cancelled',
        data: {
          scopeId: request.scopeId,
          authoredNodeId: request.authoredNodeId,
          nodeInstanceId: request.nodeInstanceId,
          attemptId: request.attemptId,
          attemptOrdinal: request.attemptOrdinal,
        },
      });
    }
    return result;
  };
