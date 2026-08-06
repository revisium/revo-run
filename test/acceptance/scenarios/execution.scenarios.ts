import { cancellationScenarios } from './cancellation.scenarios.js';
import { executionValidationScenarios } from './execution-validation.scenarios.js';
import { executorScenarios } from './executor.scenarios.js';
import { recoveryScenarios } from './recovery.scenarios.js';
import { retryScenarios } from './retry.scenarios.js';

export const executionScenarios = [
  ...executorScenarios,
  ...retryScenarios,
  ...recoveryScenarios,
  ...cancellationScenarios,
  ...executionValidationScenarios,
] as const;
