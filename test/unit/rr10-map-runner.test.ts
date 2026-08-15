import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  continued,
  execution,
  mapNode,
  mapRunnerHarness,
} from '../support/map/map-runner-harness.js';

describe('RR-10 DBOS map scheduler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('persists an all-settled decision for an empty map without starting a child', async () => {
    const subject = mapRunnerHarness({}, []);

    await expect(subject.runner.execute(execution(mapNode(), []))).resolves.toEqual({
      kind: 'continued',
      outcome: 'completed',
      output: {
        summary: {
          kind: 'json',
          value: { totalItems: 0, completedItems: 0, failedItems: 0, failures: [] },
        },
      },
    });
    expect(subject.inputs).toEqual([]);
    expect(subject.decisions).toHaveLength(1);
    expect(subject.decisions[0]).toMatchObject({ control: 'allSettled', admitted: [] });
  });

  it('holds map-local concurrency and summarizes collect failures in source order', async () => {
    const keys = ['a', 'b', 'c', 'd'];
    const subject = mapRunnerHarness(
      {
        a: continued(0, 'a', 'failed'),
        b: continued(1, 'b'),
        c: continued(2, 'c', 'failed'),
        d: continued(3, 'd'),
      },
      ['b', 'a', 'c', 'd'],
    );

    await expect(subject.runner.execute(execution(mapNode(), keys))).resolves.toMatchObject({
      kind: 'continued',
      outcome: 'completedWithErrors',
      output: {
        summary: {
          value: {
            totalItems: 4,
            completedItems: 2,
            failedItems: 2,
            failures: [
              { itemKey: 'a', outcome: 'failed' },
              { itemKey: 'c', outcome: 'failed' },
            ],
          },
        },
      },
    });
    expect(subject.inputs.map(({ itemKey }) => itemKey)).toEqual(keys);
    expect(subject.decisions[0]).toMatchObject({
      control: 'allSettled',
      summaryEligibleItemKeys: keys,
    });
  });

  it('persists fail-fast cancel before cancellation and never admits pending items', async () => {
    const lifecycle: string[] = [];
    const subject = mapRunnerHarness(
      { a: continued(0, 'a', 'failed'), b: continued(1, 'b') },
      ['a', 'b'],
      lifecycle,
    );

    await expect(
      subject.runner.execute(
        execution(mapNode({ kind: 'failFast', remaining: 'cancel' }), ['a', 'b', 'c']),
      ),
    ).resolves.toMatchObject({
      kind: 'continued',
      outcome: 'failed',
      output: { summary: { value: { totalItems: 3, failedItems: 1 } } },
    });
    expect(subject.inputs.map(({ itemKey }) => itemKey)).toEqual(['a', 'b']);
    expect(subject.decisions[0]).toMatchObject({
      control: 'failureDecided',
      decisiveItemKey: 'a',
      summaryEligibleItemKeys: ['a'],
      admitted: [
        { sourceIndex: 0, itemKey: 'a' },
        { sourceIndex: 1, itemKey: 'b' },
      ],
      remaining: [{ sourceIndex: 2, itemKey: 'c', disposition: 'cancel' }],
    });
    expect(lifecycle.indexOf('decision')).toBeLessThan(lifecycle.indexOf('cancel'));
    expect(subject.cancelScopes).toHaveBeenCalledOnce();
  });

  it('drains active execution and starts queued scopes as settlement-only', async () => {
    const subject = mapRunnerHarness({ a: continued(0, 'a', 'failed'), b: continued(1, 'b') }, [
      'a',
      'b',
      'c',
      'd',
    ]);

    await expect(
      subject.runner.execute(
        execution(mapNode({ kind: 'failFast', remaining: 'drain' }), ['a', 'b', 'c', 'd']),
      ),
    ).resolves.toMatchObject({
      kind: 'continued',
      outcome: 'failed',
      output: { summary: { value: { totalItems: 4, failedItems: 1 } } },
    });
    expect(subject.inputs.map(({ itemKey, disposition }) => [itemKey, disposition])).toEqual([
      ['a', 'execute'],
      ['b', 'execute'],
      ['c', 'settlementOnly'],
      ['d', 'settlementOnly'],
    ]);
    expect(subject.cancelScopes).not.toHaveBeenCalled();
  });

  it('rejects malformed durable child output before persisting a decision', async () => {
    const node = mapNode();
    const subject = mapRunnerHarness(
      { a: { kind: 'continued', sourceIndex: 0, itemKey: 'other', outcome: 'completed' } },
      ['a'],
    );

    await expect(subject.runner.execute(execution(node, ['a']))).rejects.toThrow(
      'Map item workflow returned another item identity.',
    );
    expect(subject.decisions).toEqual([]);
  });
});
