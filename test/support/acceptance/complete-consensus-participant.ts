import { DBOS } from '@dbos-inc/dbos-sdk';

import type { ConsensusVote } from '../../../src/contracts/pipeline/consensus-vote.js';
import type { ConsensusNode } from '../../../src/contracts/pipeline/pipeline-node.js';
import { runCoordinatorTopic } from '../../../src/dbos/dbos-names.js';
import { runWorkflowId, scopeWorkflowId } from '../../../src/dbos/workflow-id.js';
import type { ExecutionPlan, RunConsensus, RunManager } from '../../../src/index.js';
import type { ControlledRunExecutor } from '../executor/controlled-run-executor.js';

const participantPath = (vote: ConsensusVote): string => `${vote.nodePath}/${vote.participantId}`;

const authoredParticipantIds = (plan: ExecutionPlan, displayPath: string): readonly string[] => {
  const node = findConsensusNode(plan, displayPath);
  return node === undefined ? [] : Object.keys(node.participants);
};

const findConsensusNode = (plan: ExecutionPlan, displayPath: string): ConsensusNode | undefined => {
  const visit = (
    node: ExecutionPlan['pipelines'][string]['root'],
    parentPath: string,
    pipelineId: string,
    runtimePrefix: string,
  ): ConsensusNode | undefined => {
    const nodePath =
      node.kind === 'end' || node.kind === 'outcomeSwitch' || node.kind === 'sequence'
        ? parentPath
        : parentPath.length === 0
          ? node.key
          : `${parentPath}/${node.key}`;
    const runtimePath = nodePath.length === 0 ? runtimePrefix : `${runtimePrefix}/${nodePath}`;
    if (node.kind === 'consensus' && (nodePath === displayPath || runtimePath === displayPath)) {
      return node;
    }
    if (node.kind === 'subpipeline') {
      const pipeline = plan.pipelines[node.pipelineId];
      return pipeline === undefined
        ? undefined
        : visit(pipeline.root, '', node.pipelineId, runtimePath);
    }
    if (node.kind === 'consensus') {
      return undefined;
    }
    const children =
      node.kind === 'sequence'
        ? node.children
        : node.kind === 'outcomeSwitch'
          ? [
              node.source,
              ...Object.values(node.cases),
              ...(node.default === undefined ? [] : [node.default]),
            ]
          : node.kind === 'branch'
            ? [...Object.values(node.cases), ...(node.default === undefined ? [] : [node.default])]
            : node.kind === 'parallel'
              ? Object.values(node.branches)
              : node.kind === 'map' || node.kind === 'repeat'
                ? [node.body]
                : [];
    for (const child of children) {
      const match = visit(child, nodePath, pipelineId, runtimePrefix);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  };
  const root = plan.pipelines[plan.rootPipelineId]?.root;
  return root === undefined ? undefined : visit(root, '', plan.rootPipelineId, plan.rootPipelineId);
};

const isClassified = (consensus: RunConsensus, participantId: string): boolean =>
  consensus.acceptedVotes.some((entry) => entry.participantId === participantId) ||
  consensus.failedParticipantIds.includes(participantId) ||
  consensus.invalidParticipantIds.includes(participantId);

const matchingConsensus = (
  details: Awaited<ReturnType<RunManager['getRunDetails']>>,
  nodePath: string,
): RunConsensus | undefined =>
  details?.consensuses.find(
    (entry) => entry.displayPath === nodePath || entry.nodePath === nodePath,
  );

const waitFor = async <Value>(
  observe: () => Promise<Value | undefined>,
  message: string,
): Promise<Value> => {
  const deadline = Date.now() + 10_000;
  const poll = async (): Promise<Value> => {
    const value = await observe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    return poll();
  };
  return poll();
};

const injectSettlement = async (
  runId: string,
  consensus: RunConsensus,
  vote: ConsensusVote,
): Promise<void> => {
  await DBOS.send(
    runWorkflowId(runId),
    {
      kind: 'consensusParticipantSettled',
      workflowId: scopeWorkflowId(consensus.scopeId),
      consensusNodeInstanceId: consensus.nodeInstanceId,
      participantId: vote.participantId,
      settlement: { kind: 'voted', vote },
    },
    runCoordinatorTopic,
  );
};

export const completeConsensusParticipant = async (
  manager: RunManager,
  executor: ControlledRunExecutor,
  runId: string,
  plan: ExecutionPlan,
  vote: ConsensusVote,
): Promise<void> => {
  const consensus = await waitFor(
    async () => matchingConsensus(await manager.getRunDetails(runId), vote.nodePath),
    `Consensus ${vote.nodePath} was not registered.`,
  );
  const authored = authoredParticipantIds(plan, consensus.nodePath);
  if (!authored.includes(vote.participantId) || isClassified(consensus, vote.participantId)) {
    await injectSettlement(runId, consensus, vote);
    return;
  }
  const classifiedOrPending = await waitFor(async () => {
    const current = matchingConsensus(await manager.getRunDetails(runId), vote.nodePath);
    if (current !== undefined && isClassified(current, vote.participantId)) {
      return { kind: 'classified' as const, consensus: current };
    }
    if (executor.hasPending(participantPath(vote))) {
      return { kind: 'pending' as const };
    }
    return undefined;
  }, `Consensus participant ${vote.participantId} did not become pending or classified.`);
  if (classifiedOrPending.kind === 'classified') {
    await injectSettlement(runId, classifiedOrPending.consensus, vote);
    return;
  }
  await executor.complete(participantPath(vote), {
    kind: 'completed',
    outcome: vote.vote,
    output: { vote: { kind: 'json', value: vote } },
  });
};
