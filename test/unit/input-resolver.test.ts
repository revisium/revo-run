import { describe, expect, it } from 'vitest';

import { InputResolver } from '../../src/pipeline/data/input-resolver.js';

describe('pipeline input resolution', () => {
  it('preserves a direct secret reference and rejects flattening it into JSON', () => {
    const resolver = new InputResolver({
      runInput: null,
      pipelineInput: {
        kind: 'mapping',
        values: {
          credential: { kind: 'secret', reference: { name: 'production-token' } },
        },
      },
      outputs: new Map(),
    });

    expect(resolver.resolve({ kind: 'pipelineInput', path: '/credential' })).toEqual({
      resolved: true,
      value: { kind: 'secret', reference: { name: 'production-token' } },
    });
    expect(resolver.resolve({ kind: 'pipelineInput', path: '' })).toEqual({
      resolved: false,
      errorCode: 'input_source_unavailable',
    });
  });

  it('resolves current iteration input and the previous optional output', () => {
    const resolver = new InputResolver({
      runInput: null,
      pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
      outputs: new Map(),
      iterationInput: { change: { kind: 'json', value: { revision: 1 } } },
      iterationOutput: {
        result: { kind: 'json', value: { change: { revision: 2 } } },
      },
    });

    expect(resolver.resolve({ kind: 'iterationInput', path: '/change/revision' })).toEqual({
      resolved: true,
      value: { kind: 'json', value: 1 },
    });
    expect(
      resolver.resolve({ kind: 'iterationOutput', outputKey: 'result', path: '/change/revision' }),
    ).toEqual({ resolved: true, value: { kind: 'json', value: 2 } });
  });

  it('resolves the nearest raw map item and distinguishes absence from pointer failure', () => {
    const context = {
      runInput: null,
      pipelineInput: { kind: 'value' as const, value: { kind: 'json' as const, value: null } },
      outputs: new Map(),
    };
    expect(
      new InputResolver({ ...context, mapItem: { key: 'raw', nested: [1] } }).resolve({
        kind: 'mapItem',
        path: '',
      }),
    ).toEqual({
      resolved: true,
      value: { kind: 'json', value: { key: 'raw', nested: [1] } },
    });
    expect(
      new InputResolver({ ...context, mapItem: { key: 'raw', nested: [1] } }).resolve({
        kind: 'mapItem',
        path: '/nested/0',
      }),
    ).toEqual({ resolved: true, value: { kind: 'json', value: 1 } });
    expect(new InputResolver(context).resolve({ kind: 'mapItem', path: '' })).toEqual({
      resolved: false,
      errorCode: 'input_source_unavailable',
    });
    expect(
      new InputResolver({ ...context, mapItem: { key: 'raw' } }).resolve({
        kind: 'mapItem',
        path: '/missing',
      }),
    ).toEqual({ resolved: false, errorCode: 'json_pointer_not_found' });
  });

  it('classifies absent output, missing keys, and invalid JSON traversal distinctly', () => {
    const context = {
      runInput: null,
      pipelineInput: { kind: 'value' as const, value: { kind: 'json' as const, value: null } },
      outputs: new Map(),
      iterationInput: {},
    };

    expect(
      new InputResolver(context).resolve({ kind: 'iterationOutput', outputKey: 'result' }),
    ).toEqual({ resolved: false, errorCode: 'input_source_unavailable' });
    expect(
      new InputResolver({ ...context, iterationOutput: {} }).resolve({
        kind: 'iterationOutput',
        outputKey: 'result',
      }),
    ).toEqual({ resolved: false, errorCode: 'output_key_not_found' });
    expect(
      new InputResolver({
        ...context,
        iterationOutput: { result: { kind: 'json', value: { change: 1 } } },
      }).resolve({ kind: 'iterationOutput', outputKey: 'result', path: '/missing' }),
    ).toEqual({ resolved: false, errorCode: 'json_pointer_not_found' });
  });
});
