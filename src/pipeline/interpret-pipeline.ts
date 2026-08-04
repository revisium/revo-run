import { createHash } from 'node:crypto';

import {
  decidePipeline,
  decodeCompiledPipeline,
  type CandidateVerdict,
  type NodeFact,
  type PipelineFacts,
} from '@revisium/revo-pipeline';

import type { JsonValue } from '../types.js';

export interface PipelineExecution {
  executeTask(nodeKey: string): Promise<'completed' | 'failed'>;
  executeCandidate(nodeKey: string, candidate: string): Promise<'approve' | 'reject'>;
}

export const childWorkflowId = (...components: readonly string[]): string => {
  const hash = createHash('sha256');
  for (const component of components) {
    const bytes = Buffer.from(component);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return `revo-run-child-${hash.digest('hex')}`;
};

export const interpretPipeline = async (source: JsonValue, execution: PipelineExecution) => {
  const decoding = decodeCompiledPipeline(source);
  if (!decoding.ok) throw new Error('Execution plan contains an invalid compiled pipeline.');
  const nodes = new Map<string, NodeFact>();
  const verdicts: CandidateVerdict[] = [];
  const facts = (): PipelineFacts => ({
    candidateVerdicts: verdicts,
    gateResolutions: [],
    nodes: [...nodes.values()],
    values: [],
  });
  const enable = (key: string): void => {
    if (!nodes.has(key)) nodes.set(key, { key, state: 'enabled' });
  };

  const advance = async (): Promise<{ outcome: string; terminalNode: string }> => {
    const decision = decidePipeline(decoding.pipeline, facts());
    if (decision.kind === 'activate') {
      decision.nodeKeys.forEach(enable);
      return advance();
    }
    if (decision.kind === 'select') {
      nodes.set(decision.nodeKey, {
        key: decision.nodeKey,
        outcome: decision.outcome,
        state: 'terminal',
      });
      decision.activate.forEach(enable);
      return advance();
    }
    if (decision.kind === 'terminal') {
      return { outcome: decision.outcome, terminalNode: decision.nodeKey };
    }
    if (decision.kind === 'reject') {
      throw new Error(`Pipeline rejected: ${decision.faults.map(({ code }) => code).join(', ')}`);
    }
    if (decision.kind === 'noop') {
      throw new Error('Pipeline became quiescent before reaching a terminal node.');
    }
    const node = decoding.pipeline.nodes.find(({ key }) => key === decision.nodeKey);
    if (node?.kind === 'task') {
      const readyTasks = decoding.pipeline.nodes.filter(
        (candidate) => candidate.kind === 'task' && nodes.get(candidate.key)?.state === 'enabled',
      );
      const outcomes = await Promise.all(
        readyTasks.map(async (task) => ({
          key: task.key,
          outcome: await execution.executeTask(task.key),
        })),
      );
      for (const outcome of outcomes) {
        nodes.set(outcome.key, {
          key: outcome.key,
          outcome: outcome.outcome,
          state: 'terminal',
        });
      }
      return advance();
    }
    if (node?.kind === 'consensus') {
      verdicts.push(
        ...(await Promise.all(
          node.candidates.map(async (candidate) => ({
            candidate,
            nodeKey: node.key,
            verdict: await execution.executeCandidate(node.key, candidate),
          })),
        )),
      );
      return advance();
    }
    throw new Error(`Pipeline cannot satisfy wait at ${decision.nodeKey}.`);
  };
  return advance();
};
