import { describe, expect, it } from 'vitest';

import { plannedPipelineScenarios } from './capability-matrix.js';
import { executableScenarioProofTest, scenarioAuditManifest } from './scenario-audit-manifest.js';
import {
  approvedScenarioIntents,
  maximumPendingScenarioCount,
  provenExecutableIntentIds,
} from './scenario-intent-baseline.js';
import {
  executablePipelineScenarios,
  implementedCapabilities,
  missingScenarioCapabilities,
  pendingPipelineScenarios,
} from './scenario-readiness.js';

describe('acceptance scenario contract', () => {
  it('gives every approved intent a stable identity and non-empty leaf requirements', () => {
    expect(plannedPipelineScenarios).toHaveLength(103);
    expect(new Set(plannedPipelineScenarios.map(({ intentId }) => intentId)).size).toBe(103);
    expect(
      plannedPipelineScenarios.every(
        ({ requiredCapabilities }) =>
          requiredCapabilities.length > 0 &&
          new Set(requiredCapabilities).size === requiredCapabilities.length,
      ),
    ).toBe(true);
  });

  it('keeps exact intent identity, name, and category traceability', () => {
    expect(
      plannedPipelineScenarios.map(({ intentId, category, name }) => ({
        intentId,
        category,
        name,
      })),
    ).toEqual(approvedScenarioIntents);
  });

  it('has no missing or unused audit manifest entries', () => {
    const declaredIds = plannedPipelineScenarios.map(({ intentId }) => intentId).sort();
    const auditedIds = scenarioAuditManifest.map(({ intentId }) => intentId).sort();

    expect(scenarioAuditManifest).toHaveLength(103);
    expect(new Set(auditedIds).size).toBe(103);
    expect(auditedIds).toEqual(declaredIds);
  });

  it('matches every audited capability assignment to its declaration', () => {
    const scenariosById = new Map(
      plannedPipelineScenarios.map((scenario) => [scenario.intentId, scenario]),
    );

    for (const entry of scenarioAuditManifest) {
      const declaredScenario = scenariosById.get(entry.intentId);
      if (declaredScenario === undefined) {
        throw new Error(`Audited scenario ${entry.intentId} is not declared.`);
      }
      expect(entry.requiredCapabilities).toEqual(declaredScenario.requiredCapabilities);
    }
  });

  it('keeps executable and pending evidence consistent with mechanical readiness', () => {
    expect(executableScenarioProofTest).toBe('test/acceptance/pipeline-execution.test.ts');

    const scenariosById = new Map(
      plannedPipelineScenarios.map((scenario) => [scenario.intentId, scenario]),
    );
    const expectedEvidence = scenarioAuditManifest.map((entry) => {
      const scenario = scenariosById.get(entry.intentId);
      if (scenario === undefined) {
        throw new Error(`Audited scenario ${entry.intentId} is not declared.`);
      }
      const missingCapabilities = missingScenarioCapabilities(scenario);
      return missingCapabilities.length === 0
        ? { kind: 'executableScenario', proofIntentId: entry.intentId }
        : { kind: 'pendingCapabilities', missingCapabilities };
    });

    expect(scenarioAuditManifest.map(({ evidence }) => evidence)).toEqual(expectedEvidence);
  });

  it('partitions scenarios only by their missing capabilities', () => {
    expect(executablePipelineScenarios.length + pendingPipelineScenarios.length).toBe(103);
    expect(
      executablePipelineScenarios.every(
        (scenario) => missingScenarioCapabilities(scenario).length === 0,
      ),
    ).toBe(true);
    expect(
      pendingPipelineScenarios.every(
        (scenario) => missingScenarioCapabilities(scenario).length > 0,
      ),
    ).toBe(true);
  });

  it('pins all proven executable identities and the exact pending ratchet', () => {
    expect(executablePipelineScenarios.map(({ intentId }) => intentId)).toEqual(
      provenExecutableIntentIds,
    );
    expect(executablePipelineScenarios).toHaveLength(72);
    expect(pendingPipelineScenarios).toHaveLength(maximumPendingScenarioCount);
    expect(pendingPipelineScenarios).toHaveLength(31);
    expect(pendingPipelineScenarios.map(({ intentId }) => intentId)).toContain('rr-034');
  });

  it('proves every implemented atom through an executable manifest scenario', () => {
    const executableIds = new Set(executablePipelineScenarios.map(({ intentId }) => intentId));

    for (const capability of implementedCapabilities) {
      expect(
        scenarioAuditManifest.some(
          (entry) =>
            entry.evidence.kind === 'executableScenario' &&
            executableIds.has(entry.evidence.proofIntentId) &&
            entry.requiredCapabilities.some(
              (requiredCapability) => requiredCapability === capability,
            ),
        ),
      ).toBe(true);
    }
  });

  describe.each(pendingPipelineScenarios)('$intentId $name', () => {
    it.todo('executes the planned scenario');
  });
});
