import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('RR-07 v1 replay compatibility', () => {
  it('keeps v1 workflow source free of v2 readiness, cancellation, and resolution operations', () => {
    for (const path of [
      'src/dbos/workflows/run-workflow.ts',
      'src/dbos/workflows/run-execution-workflow.ts',
      'src/dbos/workflows/parallel-branch-workflow.ts',
      'src/dbos/workflows/create-pipeline-execution.ts',
    ]) {
      const contents = source(path);
      expect(contents).not.toContain('V2');
      expect(contents).not.toContain('scopeReady');
      expect(contents).not.toContain('scopeBoundary');
      expect(contents).not.toContain('waitForUnknownOutcome');
      expect(contents).not.toContain('cancelRun');
    }
  });

  it('preserves the v1 root durable operation order', () => {
    const contents = source('src/dbos/workflows/run-workflow.ts');
    const operations = [
      'DBOS.startWorkflow',
      'coordinator.execute',
      'events.append',
      'events.close',
    ].map((needle) => contents.indexOf(needle));

    expect(operations.every((index) => index >= 0)).toBe(true);
    expect(operations).toEqual([...operations].sort((left, right) => left - right));
  });
});
