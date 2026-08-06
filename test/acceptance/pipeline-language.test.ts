import { describe, expect, it } from 'vitest';

import { ExecutionPlanValidator } from '../../src/validation/execution-plan.validator.js';
import { plannedPipelineScenarios } from './capability-matrix.js';

describe('pipeline capability matrix', () => {
  it('uses unique scenario names and explicit expectations', () => {
    const names = plannedPipelineScenarios.map(({ name }) => name);

    expect(new Set(names).size).toBe(names.length);
    expect(plannedPipelineScenarios.every(({ steps }) => steps.length > 0)).toBe(true);
    expect(plannedPipelineScenarios.every(({ steps }) => steps[0]?.kind === 'startRun')).toBe(true);
    expect(
      plannedPipelineScenarios.every(({ steps }) =>
        steps.some(({ kind }) => kind.startsWith('expect')),
      ),
    ).toBe(true);
  });

  it('keeps every planned execution plan immutable-data compatible', () => {
    for (const { plan } of plannedPipelineScenarios) {
      expect(JSON.parse(JSON.stringify(plan))).toStrictEqual(plan);
      expect(plan.schemaVersion).toBe(1);
    }
  });

  it('validates every non-rejection scenario against the execution plan schema', () => {
    const admittedScenarios = plannedPipelineScenarios.filter(
      ({ steps }) => !steps.some(({ kind }) => kind === 'expectPlanRejected'),
    );

    for (const { name, plan } of admittedScenarios) {
      expect({ name, valid: ExecutionPlanValidator.Check(plan) }).toEqual({
        name,
        valid: true,
      });
    }
  });

  it('covers every approved capability with an explicit scenario count', () => {
    const counts = Object.groupBy(plannedPipelineScenarios, ({ capability }) => capability);

    expect(
      Object.fromEntries(
        Object.entries(counts).map(([capability, scenarios]) => [
          capability,
          scenarios?.length ?? 0,
        ]),
      ),
    ).toEqual({
      agentExecution: 3,
      cancellation: 5,
      concurrency: 1,
      consensus: 7,
      dataFlow: 12,
      delay: 2,
      humanGate: 8,
      map: 7,
      parallelExecution: 7,
      recovery: 7,
      repeat: 4,
      retry: 4,
      scriptExecution: 3,
      subpipeline: 3,
      subscription: 5,
      validation: 20,
    });
  });

  describe.each(plannedPipelineScenarios)('$name', () => {
    it.todo('executes the planned scenario'); // NOSONAR: blocked capability contract.
  });
});
