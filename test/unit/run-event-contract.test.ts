import { describe, expect, expectTypeOf, it } from 'vitest';

import type { RunEvent } from '../../src/index.js';
import { parseRunCoordinatorMessage } from '../../src/validation/run-coordinator-message.validator.js';
import { parseRunEvent } from '../../src/validation/run-event.validator.js';

const digest = (character: string): string => character.repeat(43);
const scopeId = `sc1_${digest('a')}`;
const authoredNodeId = `an1_${digest('b')}`;
const nodeInstanceId = `ni1_${digest('c')}`;
const attemptId = `at1_${digest('d')}`;
const cursor = 'run-1:1';
const timestamp = '2026-08-10T12:34:56.789Z';

const nodeIdentity = { scopeId, authoredNodeId, nodeInstanceId } as const;
const attemptIdentity = { ...nodeIdentity, attemptId, attemptOrdinal: 1 } as const;

const goldenEvents = [
  {
    cursor,
    timestamp,
    type: 'nodeExecution.started',
    data: attemptIdentity,
  },
  {
    cursor,
    timestamp,
    type: 'nodeExecution.completed',
    data: { ...attemptIdentity, outcome: 'completed' },
  },
  {
    cursor,
    timestamp,
    type: 'nodeExecution.failed',
    data: { ...attemptIdentity, errorCode: 'execution_failed' },
  },
  {
    cursor,
    timestamp,
    type: 'nodeExecution.timedOut',
    data: attemptIdentity,
  },
  {
    cursor,
    timestamp,
    type: 'inputResolution.failed',
    data: { ...nodeIdentity, errorCode: 'input_not_found' },
  },
  {
    cursor,
    timestamp,
    type: 'pipeline.invalidState',
    data: { ...nodeIdentity, errorCode: 'terminal_not_reached' },
  },
  {
    cursor,
    timestamp,
    type: 'pipeline.branchDefaulted',
    data: nodeIdentity,
  },
  {
    cursor,
    timestamp,
    type: 'parallel.joinFailed',
    data: nodeIdentity,
  },
  {
    cursor,
    timestamp,
    type: 'subpipeline.failed',
    data: nodeIdentity,
  },
  {
    cursor,
    timestamp,
    type: 'run.completed',
    data: { outcome: 'completed' },
  },
  {
    cursor,
    timestamp,
    type: 'run.failed',
    data: { outcome: 'failed' },
  },
] as const satisfies readonly RunEvent[];

const draftFrom = (event: RunEvent): unknown => ({ type: event.type, data: event.data });

describe('run event contract', () => {
  it('derives a closed public discriminated union from the stored event schema', () => {
    expectTypeOf<RunEvent>().toMatchTypeOf<{
      readonly cursor: string;
      readonly timestamp: string;
      readonly type: string;
      readonly data: object;
    }>();
  });

  it.each(goldenEvents)('accepts the $type golden vector', (event) => {
    expect(parseRunEvent(event)).toStrictEqual(event);
  });

  it.each(goldenEvents.slice(0, 9))('accepts the $type child event draft', (event) => {
    expect(parseRunCoordinatorMessage({ kind: 'event', event: draftFrom(event) })).toStrictEqual({
      kind: 'event',
      event: draftFrom(event),
    });
  });

  it.each([
    { ...goldenEvents[0], contractVersion: 1 },
    { ...goldenEvents[0], path: 'main/work' },
    { ...goldenEvents[0], data: { ...goldenEvents[0].data, output: { leaked: true } } },
    { ...goldenEvents[2], data: { ...goldenEvents[2].data, errorMessage: 'sensitive' } },
    { ...goldenEvents[4], data: { ...goldenEvents[4].data, secret: 'top-secret' } },
    { ...goldenEvents[4], data: { ...goldenEvents[4].data, reference: 'secret://token' } },
    { ...goldenEvents[4], data: { ...goldenEvents[4].data, name: 'credential-name' } },
  ])('rejects unapproved or secret-bearing fields %#', (event) => {
    expect(() => parseRunEvent(event)).toThrow('Stored run event is invalid.');
  });

  it.each([
    { ...goldenEvents[0], cursor: 'run-1:0' },
    { ...goldenEvents[0], cursor: `run-1:${Number.MAX_SAFE_INTEGER + 1}` },
    { ...goldenEvents[0], cursor: 'run:1:1' },
    { ...goldenEvents[0], timestamp: '2026-08-10T12:34:56Z' },
    { ...goldenEvents[0], timestamp: '2026-13-10T12:34:56.789Z' },
    { ...goldenEvents[0], data: { ...goldenEvents[0].data, scopeId: `scope_${digest('a')}` } },
    {
      ...goldenEvents[0],
      data: { ...goldenEvents[0].data, authoredNodeId: `node_${digest('b')}` },
    },
    {
      ...goldenEvents[0],
      data: { ...goldenEvents[0].data, nodeInstanceId: `instance_${digest('c')}` },
    },
    { ...goldenEvents[0], data: { ...goldenEvents[0].data, attemptId: `attempt_${digest('d')}` } },
    { ...goldenEvents[0], data: { ...goldenEvents[0].data, attemptOrdinal: 0 } },
    { ...goldenEvents[1], data: { ...goldenEvents[1].data, outcome: 'invalid/outcome' } },
    { ...goldenEvents[2], data: { ...goldenEvents[2].data, errorCode: 'invalid/error' } },
    { ...goldenEvents[0], data: null },
    { ...goldenEvents[0], type: 'nodeExecution.unknown' },
  ])('rejects malformed stored data %#', (event) => {
    expect(() => parseRunEvent(event)).toThrow('Stored run event is invalid.');
  });

  it('rejects terminal drafts sent by child workflows', () => {
    expect(() =>
      parseRunCoordinatorMessage({ kind: 'event', event: draftFrom(goldenEvents[10]) }),
    ).toThrow('Run coordinator received an invalid message.');
  });
});
