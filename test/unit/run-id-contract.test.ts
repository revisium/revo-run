import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import { RunIdSchema } from '../../src/index.js';

const validator = Schema.Compile(RunIdSchema);

describe('public run ID contract', () => {
  it.each(['A', 'a.b-c_d', `R${'x'.repeat(127)}`])('accepts %s', (runId) => {
    expect(validator.Check(runId)).toBe(true);
  });

  it.each(['', '1run', 'run:reserved', 'run space', `R${'x'.repeat(128)}`])(
    'rejects %s',
    (runId) => {
      expect(validator.Check(runId)).toBe(false);
    },
  );
});
