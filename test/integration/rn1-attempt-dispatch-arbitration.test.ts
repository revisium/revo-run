import { readFileSync } from 'node:fs';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  arbitrateAttemptDispatch,
  attemptDispatchArbitrationWorkflowName,
  isAttemptDispatchArbitrationRecord,
  type AttemptDispatchArbitrationRecordV1,
} from '../../src/dbos/attempt-dispatch-arbitration.js';
import { attemptDispatchArbitrationWorkflowId } from '../../src/operations/identities.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const arbitrationFixture: unknown = JSON.parse(
  readFileSync(
    new URL('../contracts/fixtures/identities/attempt-dispatch-arbitration.json', import.meta.url),
    'utf8',
  ),
);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredRecord = (value: unknown, name: string): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) {
    throw new Error(`Arbitration fixture has no ${name} record.`);
  }
  return value;
};

const requiredString = (value: Readonly<Record<string, unknown>>, name: string): string => {
  if (typeof value[name] !== 'string') {
    throw new Error(`Arbitration fixture has no ${name} string.`);
  }
  return value[name];
};

const requiredRecords = (
  value: Readonly<Record<string, unknown>>,
  name: string,
): readonly unknown[] => {
  if (!Array.isArray(value[name])) {
    throw new Error(`Arbitration fixture has no ${name} records.`);
  }
  return value[name];
};

beforeAll(async () => {
  DBOS.setConfig({
    name: 'revo-run-rn1-attempt-arbitration',
    executorID: 'revo-run-rn1-attempt-arbitration',
    systemDatabaseSchemaName: 'dbos_rn1_attempt_arbitration',
    systemDatabaseUrl: testDatabaseUrl(),
  });
  await DBOS.launch();
});

afterAll(async () => {
  await DBOS.shutdown();
});

describe('RN1 attempt dispatch arbitration', () => {
  it('stores the fixture first input/result exactly and creates no DBOS steps', async () => {
    const fixture = requiredRecord(arbitrationFixture, 'fixture');
    const input = requiredRecord(fixture.input, 'input');
    const expected = requiredRecord(fixture.expected, 'expected');
    const tuple = requiredRecords(fixture, 'tuple');
    const tupleJson = requiredString(fixture, 'tupleJson');
    const candidates = requiredRecords(expected, 'candidates');
    const firstInput = expected.firstInput;
    const expectedResult = expected.result;
    if (
      !isAttemptDispatchArbitrationRecord(firstInput) ||
      !isAttemptDispatchArbitrationRecord(expectedResult) ||
      !candidates.every(isAttemptDispatchArbitrationRecord)
    ) {
      throw new Error('Arbitration fixture does not contain exact candidate records.');
    }
    const executionId = requiredString(input, 'executionId');
    const attemptId = requiredString(input, 'attemptId');
    const workflowID = requiredString(expected, 'workflowId');
    expect(JSON.stringify(tuple)).toBe(tupleJson);
    expect(workflowID).toBe(attemptDispatchArbitrationWorkflowId(executionId, attemptId));
    expect(firstInput).toStrictEqual(expectedResult);

    const first = await arbitrateAttemptDispatch(firstInput);
    const later = candidates.find((candidate) => candidate.winner !== firstInput.winner);
    if (later === undefined) {
      throw new Error('Arbitration fixture has no opposing contender.');
    }
    const second = await arbitrateAttemptDispatch(later);
    expect(first).toStrictEqual(expectedResult);
    expect(second).toStrictEqual(expectedResult);

    const handle = DBOS.retrieveWorkflow<AttemptDispatchArbitrationRecordV1>(workflowID);
    const [storedInput] = await handle.getWorkflowInputs<[AttemptDispatchArbitrationRecordV1]>();
    expect(storedInput).toStrictEqual(firstInput);
    await expect(handle.getResult()).resolves.toStrictEqual(expectedResult);
    await expect(DBOS.listWorkflowSteps(workflowID)).resolves.toStrictEqual([]);
    await expect(DBOS.getWorkflowStatus(workflowID)).resolves.toMatchObject({
      workflowName: attemptDispatchArbitrationWorkflowName,
      status: 'SUCCESS',
    });
  });

  it('fails closed for each fixture malformed candidate and result record before DBOS work', async () => {
    const fixture = requiredRecord(arbitrationFixture, 'fixture');
    const negatives = requiredRecords(fixture, 'negativeRecords').map((entry) =>
      requiredRecord(entry, 'negative record'),
    );
    const candidates = negatives.filter((entry) => entry.target === 'candidate');
    const results = negatives.filter((entry) => entry.target === 'result');
    for (const candidate of candidates) {
      const expectedError = requiredString(candidate, 'expectedError');
      // oxlint-disable-next-line no-await-in-loop -- each invalid shape must fail before DBOS work.
      await expect(arbitrateAttemptDispatch(candidate.record)).rejects.toThrow(expectedError);
    }
    for (const result of results) {
      expect(isAttemptDispatchArbitrationRecord(result.record)).toBe(false);
    }
  });
});
