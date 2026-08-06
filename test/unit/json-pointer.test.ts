import { describe, expect, it } from 'vitest';

import { readJsonPointer } from '../../src/pipeline/data/json-pointer.js';

describe('JSON Pointer resolution', () => {
  it('reads object keys, arrays, and escaped tokens', () => {
    const value = { list: [{ 'a/b': { '~key': 'selected' } }] };

    expect(readJsonPointer(value, '/list/0/a~1b/~0key')).toEqual({
      found: true,
      value: 'selected',
    });
  });

  it('distinguishes missing values from JSON null', () => {
    expect(readJsonPointer({ present: null }, '/present')).toEqual({ found: true, value: null });
    expect(readJsonPointer({ present: null }, '/missing')).toEqual({ found: false });
  });
});
