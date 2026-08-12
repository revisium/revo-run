import { describe, expect, it } from 'vitest';

import {
  isNodeExecutionStepName,
  nodeExecutionStepIdentity,
  nodeExecutionStepName,
  parallelBranchWorkflowName,
  runExecutionWorkflowName,
  runWorkflowName,
} from '../../src/dbos/dbos-names.js';

describe('DBOS workflow names', () => {
  it('uses the stable first-release namespace for every workflow kind', () => {
    expect(runWorkflowName).toBe('revo-run.run.v1');
    expect(runExecutionWorkflowName).toBe('revo-run.execution.v1');
    expect(parallelBranchWorkflowName).toBe('revo-run.parallel-branch.v1');
  });
});

describe('DBOS node execution step identity', () => {
  it('round-trips the display path and positive attempt ordinal', () => {
    const name = nodeExecutionStepName('main/review', 2);

    expect(name).toBe('execute-node-attempt:2:main/review');
    expect(isNodeExecutionStepName(name)).toBe(true);
    expect(nodeExecutionStepIdentity(name)).toEqual({
      attemptOrdinal: 2,
      displayPath: 'main/review',
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid authored attempt ordinal %s',
    (attemptOrdinal) => {
      expect(() => nodeExecutionStepName('main/review', attemptOrdinal)).toThrow(
        'positive safe integer',
      );
    },
  );

  it.each([
    'execute-node-attempt:12',
    'execute-node-attempt:0:main/review',
    'execute-node-attempt:01:main/review',
    'execute-node-attempt:1.5:main/review',
    'execute-node-attempt:9007199254740992:main/review',
    'execute-node-attempt:1:',
  ])('rejects malformed durable identity %s', (name) => {
    expect(isNodeExecutionStepName(name)).toBe(true);
    expect(() => nodeExecutionStepIdentity(name)).toThrow('identity');
  });
});
