import { describe, expect, it } from 'vitest';

import { JsonValueValidator } from '../../src/validation/json-value.validator.js';
import { NodeOutputValidator } from '../../src/validation/node-output.validator.js';

describe('durable value validation', () => {
  it.each([
    { name: 'null', value: null },
    { name: 'boolean', value: true },
    { name: 'number', value: 42 },
    { name: 'string', value: 'value' },
    { name: 'array', value: [1, { nested: 'value' }] },
    { name: 'object', value: { nested: { values: [false, null] } } },
  ])('accepts JSON $name', ({ value }) => {
    expect(JsonValueValidator.Check(value)).toBe(true);
  });

  it.each([
    { name: 'undefined', value: undefined },
    { name: 'NaN', value: Number.NaN },
    { name: 'infinity', value: Number.POSITIVE_INFINITY },
    { name: 'Date', value: new Date() },
    { name: 'Map', value: new Map() },
    { name: 'nested Date', value: { nested: new Date() } },
    { name: 'nested Map', value: [new Map()] },
  ])('rejects non-JSON $name', ({ value }) => {
    expect(JsonValueValidator.Check(value)).toBe(false);
  });

  it('accepts every normalized output value kind', () => {
    expect(
      NodeOutputValidator.Check({
        artifact: {
          kind: 'artifact',
          reference: {
            id: 'artifact-1',
            digest: 'sha256:artifact',
            mediaType: 'application/json',
            size: 100,
          },
        },
        entity: {
          kind: 'entity',
          reference: { entityType: 'project', id: 'project-1', version: '7' },
        },
        result: { kind: 'json', value: { approved: true } },
      }),
    ).toBe(true);
  });

  it.each([
    { name: 'array envelope', value: [] },
    { name: 'undefined JSON value', value: { result: { kind: 'json', value: undefined } } },
    {
      name: 'incomplete artifact reference',
      value: { artifact: { kind: 'artifact', reference: { id: 'incomplete' } } },
    },
    {
      name: 'negative artifact size',
      value: {
        artifact: {
          kind: 'artifact',
          reference: {
            id: 'artifact-1',
            digest: 'sha256:artifact',
            mediaType: 'application/json',
            size: -1,
          },
        },
      },
    },
    {
      name: 'incomplete entity reference',
      value: { entity: { kind: 'entity', reference: { entityType: 'project' } } },
    },
    {
      name: 'secret output',
      value: { credential: { kind: 'secret', reference: { name: 'token' } } },
    },
  ])('rejects malformed normalized output: $name', ({ value }) => {
    expect(NodeOutputValidator.Check(value)).toBe(false);
  });

  it('rejects output keys outside the contract grammar', () => {
    expect(NodeOutputValidator.Check({ 'not an identifier': { kind: 'json', value: true } })).toBe(
      false,
    );
  });

  it('rejects additional properties in normalized output envelopes', () => {
    expect(
      NodeOutputValidator.Check({
        result: { kind: 'json', value: true, unexpected: true },
      }),
    ).toBe(false);
  });
});
