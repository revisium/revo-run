import { dataReferenceFailureScenarios } from './data-reference-failure.scenarios.js';
import { dataReferenceScenarios } from './data-reference.scenarios.js';
import { lifecycleScenarios } from './lifecycle.scenarios.js';
import { mapScenarios } from './map.scenarios.js';
import { subscriptionScenarios } from './subscription.scenarios.js';
import { validationDepthScenarios } from './validation-depth.scenarios.js';
import { validationScenarios } from './validation.scenarios.js';

export const enterpriseScenarios = [
  ...dataReferenceScenarios,
  ...dataReferenceFailureScenarios,
  ...mapScenarios,
  ...lifecycleScenarios,
  ...subscriptionScenarios,
  ...validationScenarios,
  ...validationDepthScenarios,
] as const;
