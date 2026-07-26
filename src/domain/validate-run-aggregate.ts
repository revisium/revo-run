import type { Attempt } from './attempt.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { Run } from './run.js';

type RunAggregate = {
  readonly run: Run;
  readonly nodes: readonly RunNodeInstance[];
  readonly attempts: readonly Attempt[];
};

const terminalNodeStatuses = new Set(['succeeded', 'failed', 'cancelled']);
const activeAttemptStatuses = new Set(['claimed', 'start_committed', 'unknown', 'reconciling']);

const compatible = (node: RunNodeInstance, attempt: Attempt): boolean =>
  (node.status === 'executing' &&
    (attempt.status === 'claimed' || attempt.status === 'start_committed')) ||
  (node.status === 'unknown' && (attempt.status === 'unknown' || attempt.status === 'reconciling'));

const indexAttempts = (aggregate: RunAggregate): ReadonlyMap<string, Attempt> => {
  const attempts = new Map<string, Attempt>();
  const nodeIds = new Set(aggregate.nodes.map((node) => node.id));
  for (const attempt of aggregate.attempts) {
    if (
      attempt.runId !== aggregate.run.id ||
      attempts.has(attempt.id) ||
      !nodeIds.has(attempt.nodeInstanceId)
    ) {
      throw new TypeError('Attempt aggregate identity is invalid.');
    }
    attempts.set(attempt.id, attempt);
  }
  return attempts;
};

function assertActiveAttempt(
  node: RunNodeInstance,
  attempt: Attempt | undefined,
  referencedAttempts: ReadonlySet<string>,
): asserts attempt is Attempt {
  if (
    attempt?.nodeInstanceId !== node.id ||
    !compatible(node, attempt) ||
    referencedAttempts.has(attempt.id)
  ) {
    throw new TypeError('Run node active Attempt authority is invalid.');
  }
}

const validateNodes = (
  aggregate: RunAggregate,
  attempts: ReadonlyMap<string, Attempt>,
): ReadonlySet<string> => {
  const nodeIds = new Set<string>();
  const activationCoordinates = new Set<string>();
  const referencedAttempts = new Set<string>();
  for (const node of aggregate.nodes) {
    const coordinate = `${node.runId}\u0000${node.forkScopeKey}\u0000${node.activationKey}`;
    if (
      node.runId !== aggregate.run.id ||
      nodeIds.has(node.id) ||
      activationCoordinates.has(coordinate)
    ) {
      throw new TypeError('Run node aggregate identity is invalid.');
    }
    nodeIds.add(node.id);
    activationCoordinates.add(coordinate);

    if (node.activeAttemptId === null) continue;
    const attempt = attempts.get(node.activeAttemptId);
    assertActiveAttempt(node, attempt, referencedAttempts);
    referencedAttempts.add(attempt.id);
  }
  return referencedAttempts;
};

const validateLiveAuthority = (
  attempts: readonly Attempt[],
  referencedAttempts: ReadonlySet<string>,
): void => {
  for (const attempt of attempts) {
    if (activeAttemptStatuses.has(attempt.status) !== referencedAttempts.has(attempt.id)) {
      throw new TypeError('Attempt live authority is invalid.');
    }
  }
};

const validateTerminalRun = (run: Run, nodes: readonly RunNodeInstance[]): void => {
  const terminal =
    run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
  if (
    terminal &&
    nodes.some((node) => !terminalNodeStatuses.has(node.status) || node.activeAttemptId !== null)
  ) {
    throw new TypeError('Terminal Run contains non-terminal node authority.');
  }
};

export const validateRunAggregate = (aggregate: RunAggregate): void => {
  const attempts = indexAttempts(aggregate);
  const referencedAttempts = validateNodes(aggregate, attempts);
  validateLiveAuthority(aggregate.attempts, referencedAttempts);
  validateTerminalRun(aggregate.run, aggregate.nodes);
};
