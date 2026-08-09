import { coordinationCoreScenarioAudit } from './scenario-audit/coordination-core-audit.js';
import { coordinationHumanScenarioAudit } from './scenario-audit/coordination-human-audit.js';
import { enterpriseDataScenarioAudit } from './scenario-audit/enterprise-data-audit.js';
import { enterpriseLifecycleScenarioAudit } from './scenario-audit/enterprise-lifecycle-audit.js';
import { executionScenarioAudit } from './scenario-audit/execution-audit.js';
import { validationScenarioAudit } from './scenario-audit/validation-audit.js';

export { executableScenarioProofTest } from './scenario-audit/scenario-audit-entry.js';

export const scenarioAuditManifest = [
  ...executionScenarioAudit,
  ...coordinationCoreScenarioAudit,
  ...coordinationHumanScenarioAudit,
  ...enterpriseDataScenarioAudit,
  ...enterpriseLifecycleScenarioAudit,
  ...validationScenarioAudit,
] as const;
