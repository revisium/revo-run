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
});
