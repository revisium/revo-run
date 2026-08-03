import {
  decidePipeline,
  decodeCompiledPipeline,
  type CandidateVerdict,
  type NodeFact,
  type PipelineFacts,
} from '@revisium/revo-pipeline';

import type { JsonValue } from '../../spec/index.js';
import type { PipelineExecution } from './pipeline-execution.js';
import type { PipelineInterpretation } from './pipeline-interpretation.js';

export const interpretPipeline = async (
  compiledPipeline: JsonValue,
  execution: PipelineExecution,
): Promise<PipelineInterpretation> => {
  const decoding = decodeCompiledPipeline(compiledPipeline);
  if (!decoding.ok) throw new Error('Execution plan contains an invalid compiled pipeline.');

  const nodeFacts = new Map<string, NodeFact>();
  const verdicts: CandidateVerdict[] = [];
  const facts = (): PipelineFacts => ({
    candidateVerdicts: verdicts,
    gateResolutions: [],
    nodes: [...nodeFacts.values()],
    values: [],
  });
  const enable = (nodeKey: string): void => {
    if (!nodeFacts.has(nodeKey)) nodeFacts.set(nodeKey, { key: nodeKey, state: 'enabled' });
  };

  const advance = async (): Promise<PipelineInterpretation> => {
    const decision = decidePipeline(decoding.pipeline, facts());
    switch (decision.kind) {
      case 'activate':
        decision.nodeKeys.forEach(enable);
        return advance();
      case 'select':
        nodeFacts.set(decision.nodeKey, {
          key: decision.nodeKey,
          outcome: decision.outcome,
          state: 'terminal',
        });
        decision.activate.forEach(enable);
        return advance();
      case 'wait': {
        const node = decoding.pipeline.nodes.find(({ key }) => key === decision.nodeKey);
        if (node?.kind === 'task') {
          const outcome = await execution.executeTask(node.key);
          nodeFacts.set(node.key, { key: node.key, outcome, state: 'terminal' });
          return advance();
        }
        if (node?.kind === 'consensus') {
          const completedVerdicts = await Promise.all(
            node.candidates.map(async (candidate) => ({
              candidate,
              nodeKey: node.key,
              verdict: await execution.executeCandidate(node.key, candidate),
            })),
          );
          verdicts.push(...completedVerdicts);
          return advance();
        }
        throw new Error(`Pipeline cannot satisfy wait at ${decision.nodeKey}.`);
      }
      case 'terminal':
        return { outcome: decision.outcome, terminalNode: decision.nodeKey };
      case 'noop':
        throw new Error('Pipeline became quiescent before reaching a terminal node.');
      case 'reject':
        throw new Error(`Pipeline rejected: ${decision.faults.map(({ code }) => code).join(', ')}`);
    }
    throw new Error('Pipeline returned an unsupported decision.');
  };

  return advance();
};
