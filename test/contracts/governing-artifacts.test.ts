import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { attemptDispatchArbitrationCandidate } from '../../src/dbos/attempt-dispatch-arbitration.js';
import {
  RunDetailsSchema,
  RunEventPageInputSchema,
  RunEventPageSchema,
  RunEventSchema,
  RunManagerErrorSchema,
  RunPageSchema,
  RunSnapshotSchema,
} from '../../src/index.js';
import {
  attemptDispatchArbitrationIdentityToken,
  attemptDispatchArbitrationWorkflowId,
  attemptId,
  eventReceiptId,
  gateId,
  operationId,
  operationReceiptId,
  recoveryReceiptId,
  retryStartReceiptId,
  waitId,
} from '../../src/operations/identities.js';

const artifactRoot = new URL('./fixtures/', import.meta.url);
const packageRoot = new URL('../package/fixtures/', import.meta.url);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const parseJson = (url: URL): unknown => JSON.parse(readFileSync(url, 'utf8'));

const sha256 = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

const requiredVectors = (value: unknown): readonly unknown[] => {
  if (!isRecord(value) || !Array.isArray(value.vectors)) {
    throw new Error('Governing artifact is missing its golden vectors.');
  }
  return value.vectors;
};

const requiredArray = (value: unknown, key: string): readonly unknown[] => {
  if (!isRecord(value) || !Array.isArray(value[key])) {
    throw new Error(`Governing artifact is missing its ${key} golden vectors.`);
  }
  return value[key];
};

const requiredString = (value: Readonly<Record<string, unknown>>, key: string): string => {
  if (typeof value[key] !== 'string') {
    throw new Error(`Governing artifact is missing its ${key} value.`);
  }
  return value[key];
};

const requiredThreeStringTuple = (value: unknown): readonly [string, string, string] => {
  if (!isUnknownArray(value) || value.length !== 3) {
    throw new Error('Governing identity vector has an invalid tuple.');
  }
  const [first, second, third] = value;
  if (typeof first !== 'string' || typeof second !== 'string' || typeof third !== 'string') {
    throw new Error('Governing identity vector has an invalid tuple.');
  }
  return [first, second, third];
};

const requiredTwoStringTuple = (value: unknown): readonly [string, string] => {
  if (!isUnknownArray(value) || value.length !== 2) {
    throw new Error('Governing arbitration vector has an invalid tuple.');
  }
  const [first, second] = value;
  if (typeof first !== 'string' || typeof second !== 'string') {
    throw new Error('Governing arbitration vector has an invalid tuple.');
  }
  return [first, second];
};

const requiredPositiveInteger = (value: Readonly<Record<string, unknown>>, key: string): number => {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) {
    throw new Error(`Governing artifact is missing its positive ${key} value.`);
  }
  return candidate;
};

const requiredNonNegativeInteger = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): number => {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`Governing artifact is missing its non-negative ${key} value.`);
  }
  return candidate;
};

describe('RN1 governing design artifacts', () => {
  it('pins every repository-owned observation, identity, relay, recovery, and root-consumer artifact', () => {
    const manifest = parseJson(new URL('./fixtures/governing-artifacts.json', import.meta.url));
    if (!isRecord(manifest) || !isRecord(manifest.artifacts)) {
      throw new Error('Governing artifact manifest has an invalid closed shape.');
    }
    for (const [path, expectedDigest] of Object.entries(manifest.artifacts)) {
      if (typeof expectedDigest !== 'string') {
        throw new Error(`Governing artifact ${path} has no digest.`);
      }
      const url = path.startsWith('package/')
        ? new URL(path.slice('package/'.length), packageRoot)
        : path.startsWith('integration/')
          ? new URL(`../../integration/fixtures/${path.slice('integration/'.length)}`, artifactRoot)
          : path.startsWith('docs/') || path.startsWith('test/')
            ? new URL(`../../../${path}`, artifactRoot)
            : new URL(path, artifactRoot);
      expect(sha256(readFileSync(url, 'utf8'))).toBe(expectedDigest);
      if (url.pathname.endsWith('.json')) {
        if (!isRecord(parseJson(url))) {
          throw new Error(`Governing artifact ${path} must be a JSON object.`);
        }
      }
    }
  });

  it('executes the identity and arbitration vector rules instead of retaining orphaned JSON', () => {
    const identity = parseJson(
      new URL('./identities/operation-attempt-wait-gate.json', artifactRoot),
    );
    const arbitration = parseJson(
      new URL('./identities/attempt-dispatch-arbitration.json', artifactRoot),
    );
    const relay = parseJson(new URL('./identities/script-event-relay-receipts.json', artifactRoot));
    if (
      !isRecord(identity) ||
      !isRecord(identity.expected) ||
      !isRecord(arbitration) ||
      !isRecord(arbitration.input) ||
      !isRecord(arbitration.expected) ||
      !isRecord(relay) ||
      !isRecord(relay.input) ||
      !isRecord(relay.expected)
    ) {
      throw new Error('Identity vectors have an invalid closed shape.');
    }
    const [, runId, commandKey] = requiredThreeStringTuple(identity.tuple);
    const operation = operationId(runId, commandKey);
    const attempt = attemptId(operation, 1);
    expect({
      operationId: operation,
      attemptId: attempt,
      waitId: waitId(runId, commandKey),
      gateId: gateId(runId, commandKey),
      eventReceiptId: eventReceiptId(runId, operation, attempt, 1),
      operationReceiptId: operationReceiptId(runId, operation, 1),
      recoveryReceiptId: recoveryReceiptId(runId, operation, 1),
      retryStartReceiptId: retryStartReceiptId(runId, operation, 2),
    }).toStrictEqual(identity.expected);
    const arbitrationOperation = requiredString(arbitration.input, 'executionId');
    const arbitrationAttempt = requiredString(arbitration.input, 'attemptId');
    const arbitrationTuple = requiredTwoStringTuple(arbitration.tuple);
    expect(JSON.stringify(arbitrationTuple)).toBe(requiredString(arbitration, 'tupleJson'));
    expect(arbitrationTuple).toStrictEqual([arbitrationOperation, arbitrationAttempt]);
    expect({
      workflowId: attemptDispatchArbitrationWorkflowId(arbitrationOperation, arbitrationAttempt),
      identityToken: attemptDispatchArbitrationIdentityToken(
        arbitrationOperation,
        arbitrationAttempt,
      ),
    }).toStrictEqual({
      workflowId: requiredString(arbitration.expected, 'workflowId'),
      identityToken: requiredString(arbitration.expected, 'identityToken'),
    });
    expect(requiredString(relay.input, 'operationId')).toBe(operation);
    expect(requiredString(relay.input, 'attemptId')).toBe(attempt);
    expect({
      eventReceiptId: eventReceiptId(
        runId,
        operation,
        attempt,
        requiredPositiveInteger(relay, 'emissionOrdinal'),
      ),
      operationReceiptId: operationReceiptId(runId, operation, 1),
      recoveryReceiptId: recoveryReceiptId(runId, operation, 1),
      retryStartReceiptId: retryStartReceiptId(
        runId,
        operation,
        requiredPositiveInteger(relay, 'nextAttemptOrdinal'),
      ),
    }).toStrictEqual(relay.expected);
    const expectedCandidates = requiredArray(arbitration.expected, 'candidates');
    expect(
      expectedCandidates.map((candidate) => {
        if (!isRecord(candidate)) {
          throw new Error('Governing arbitration vector has an invalid candidate.');
        }
        const winner = requiredString(candidate, 'winner');
        if (winner !== 'dispatch_won' && winner !== 'cancel_won') {
          throw new Error('Governing arbitration vector has an invalid winner.');
        }
        return attemptDispatchArbitrationCandidate(
          arbitrationOperation,
          arbitrationAttempt,
          winner,
        );
      }),
    ).toStrictEqual(expectedCandidates);
    expect(arbitration.expected.firstInput).toStrictEqual(arbitration.expected.result);
    expect(requiredArray(arbitration, 'negativeRecords')).toHaveLength(6);
  });

  it('requires concrete D1–D9 recovery inputs, outcomes, and prohibited transitions', () => {
    const recovery = parseJson(
      new URL('../../integration/fixtures/recovery/d1-d9.json', artifactRoot),
    );
    if (
      !isRecord(recovery) ||
      requiredString(recovery, 'schemaVersion') !== 'rn1-durable-recovery-matrix/v1'
    ) {
      throw new Error('D1–D9 recovery matrix has an invalid closed shape.');
    }
    const scenarios = requiredArray(recovery, 'scenarios');
    expect(
      scenarios.map((scenario) => (isRecord(scenario) ? scenario.id : undefined)),
    ).toStrictEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9']);
    for (const scenario of scenarios) {
      if (
        !isRecord(scenario) ||
        !isRecord(scenario.input) ||
        !isRecord(scenario.expected) ||
        !isRecord(scenario.negative)
      ) {
        throw new Error('D1–D9 recovery scenario has an invalid closed shape.');
      }
      requiredString(scenario.input, 'runId');
      requiredString(scenario.input, 'crashPoint');
      expect(['absent', 'pending', 'terminal', 'recovery_required']).toContain(
        requiredString(scenario.expected, 'state'),
      );
      expect(['absent', 'running', 'succeeded', 'cancelled', 'recovery_required']).toContain(
        requiredString(scenario.expected, 'status'),
      );
      const events = scenario.expected.events;
      const calls = scenario.expected.calls;
      if (!isRecord(events) || !isRecord(calls)) {
        throw new Error('D1–D9 recovery scenario has no exact event/call observations.');
      }
      expect({
        script: requiredNonNegativeInteger(events, 'script'),
        kernel: requiredNonNegativeInteger(events, 'kernel'),
      }).toStrictEqual(events);
      expect({
        execute: requiredNonNegativeInteger(calls, 'execute'),
        reconcile: requiredNonNegativeInteger(calls, 'reconcile'),
        cancel: requiredNonNegativeInteger(calls, 'cancel'),
      }).toStrictEqual(calls);
      expect(Object.values(scenario.negative).every((value) => value === false)).toBe(true);
      if (scenario.id === 'D1') {
        if (
          scenario.expected.state !== 'absent' ||
          scenario.expected.status !== 'absent' ||
          scenario.expected.runExists !== false ||
          scenario.expected.operationExists !== false
        ) {
          throw new Error('D1 must leave no durable run or operation.');
        }
        continue;
      }
      const runId = requiredString(scenario.input, 'runId');
      const commandKey = requiredString(scenario.input, 'commandKey');
      const ordinal = requiredPositiveInteger(scenario.input, 'attemptOrdinal');
      const expectedOperationId = requiredString(scenario.expected, 'executionId');
      const expectedAttemptId = requiredString(scenario.expected, 'attemptId');
      const executionId = operationId(runId, commandKey);
      expect(executionId).toBe(expectedOperationId);
      expect(attemptId(executionId, ordinal)).toBe(expectedAttemptId);
    }
    const cancellation = parseJson(
      new URL('./scripts/cancellation-result-mapping.json', artifactRoot),
    );
    if (!isRecord(cancellation) || !isRecord(cancellation.attempt)) {
      throw new Error('Cancellation mapping has an invalid closed shape.');
    }
    const cancellationExecutionId = requiredString(cancellation.attempt, 'executionId');
    const cancellationAttemptId = requiredString(cancellation.attempt, 'attemptId');
    expect(requiredPositiveInteger(cancellation.attempt, 'attemptOrdinal')).toBe(1);
    expect(cancellation.attempt.input).toStrictEqual({ message: 'recovery' });
    const mappings = requiredArray(cancellation, 'mappings');
    expect(
      mappings.map((mapping) => (isRecord(mapping) ? mapping.variant : undefined)),
    ).toStrictEqual(['acknowledged', 'alreadyTerminal', 'uncertain', 'notFound', 'unknown']);
    expect(
      mappings.map((mapping) => (isRecord(mapping) ? mapping.action : undefined)),
    ).toStrictEqual([
      'reconcile_same_attempt',
      'seal_once',
      'recovery_required',
      'recovery_required_after_dispatch',
      'recovery_required',
    ]);
    for (const mapping of mappings) {
      if (!isRecord(mapping) || !isRecord(mapping.result) || !isRecord(mapping.expected)) {
        throw new Error('Cancellation mapping has an invalid result or expected observation.');
      }
      expect(['acknowledged', 'alreadyTerminal', 'uncertain', 'notFound', 'unknown']).toContain(
        requiredString(mapping, 'variant'),
      );
      expect([
        'reconcile_same_attempt',
        'seal_once',
        'recovery_required_after_dispatch',
        'recovery_required',
      ]).toContain(requiredString(mapping, 'action'));
      expect(['acknowledged', 'alreadyTerminal', 'uncertain', 'notFound', 'unknown']).toContain(
        requiredString(mapping.result, 'kind'),
      );
      expect(mapping.expected.retryCreated).toBe(false);
      expect(mapping.expected.newAttempt).toBe(false);
      expect(typeof mapping.expected.terminal).toBe('boolean');
      expect(mapping.expected).toHaveProperty('kernelEvent');
      expect(cancellationExecutionId).toMatch(/^op_/);
      expect(cancellationAttemptId).toMatch(/^att_/);
    }
  });

  it('schema-validates every snapshot, details, and event golden instead of retaining labels', () => {
    const snapshots = requiredVectors(
      parseJson(new URL('./observation/run-snapshots.json', artifactRoot)),
    );
    const details = requiredVectors(
      parseJson(new URL('./observation/run-details.json', artifactRoot)),
    );
    const events = requiredVectors(
      parseJson(new URL('./observation/run-events.json', artifactRoot)),
    );

    expect(snapshots).toHaveLength(7);
    expect(details).toHaveLength(7);
    expect(events).toHaveLength(16);
    expect(snapshots.every((snapshot) => Check(RunSnapshotSchema, snapshot))).toBe(true);
    expect(details.every((detail) => Check(RunDetailsSchema, detail))).toBe(true);
    expect(events.every((event) => Check(RunEventSchema, event))).toBe(true);
    expect(
      events.map((event) =>
        isRecord(event) && isRecord(event.payload) ? event.payload.type : undefined,
      ),
    ).toStrictEqual([
      'run.admitted',
      'run.started',
      'run.status_changed',
      'run.terminal',
      'activity.operation_created',
      'activity.operation_finished',
      'activity.attempt_started',
      'activity.attempt_finished',
      'activity.recovery_required',
      'script.event',
      'wait.opened',
      'wait.resolved',
      'gate.opened',
      'gate.resolved',
      'run.cancellation_requested',
      'run.cancellation_acknowledged',
    ]);
  });

  it('schema-validates page and error-detail goldens, including their closed negative cases', () => {
    const pages = parseJson(new URL('./observation/pages.json', artifactRoot));
    const errors = parseJson(new URL('./observation/error-details.json', artifactRoot));
    expect(requiredArray(pages, 'runPages').every((page) => Check(RunPageSchema, page))).toBe(true);
    expect(
      requiredArray(pages, 'eventPageInputs').every((input) =>
        Check(RunEventPageInputSchema, input),
      ),
    ).toBe(true);
    expect(
      requiredArray(pages, 'eventPages').every((page) => Check(RunEventPageSchema, page)),
    ).toBe(true);
    expect(requiredVectors(errors).every((error) => Check(RunManagerErrorSchema, error))).toBe(
      true,
    );
    expect(
      requiredArray(errors, 'negativeVectors').every(
        (error) => !Check(RunManagerErrorSchema, error),
      ),
    ).toBe(true);
  });

  it('keeps the package fixture root-only and raw-pipeline/profile based', () => {
    const consumer = readFileSync(
      new URL('./root-consumer/raw-create-run.ts', packageRoot),
      'utf8',
    );
    expect(consumer).toContain("from '@revisium/revo-run'");
    expect(consumer).toContain('PipelineSourcePackage');
    expect(consumer).toContain('RunProfile');
    expect(consumer).toContain('createRun({ runId:');
    expect(consumer).not.toMatch(/@revisium\/revo-run\//u);
  });
});
