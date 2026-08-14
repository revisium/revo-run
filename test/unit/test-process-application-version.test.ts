import { describe, expect, it } from 'vitest';

import { testProcessApplicationVersion } from '../support/process/test-process-application-version.js';

describe('test process application versions', () => {
  it('keeps one lineage stable and isolates owners and lineages', () => {
    const recovery = testProcessApplicationVersion('recovery', 'run-a');

    expect(testProcessApplicationVersion('recovery', 'run-a')).toBe(recovery);
    expect(testProcessApplicationVersion('recovery', 'run-b')).not.toBe(recovery);
    expect(testProcessApplicationVersion('run-observer', 'run-a')).not.toBe(recovery);
  });
});
