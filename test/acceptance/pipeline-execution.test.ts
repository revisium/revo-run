import { describe, expect, it } from 'vitest';

import { scenarioTimeoutMs } from '../dsl/scenario-time.js';
import { runAcceptanceScenario } from '../support/acceptance/run-acceptance-scenario.js';
import { executablePipelineScenarios } from './scenario-readiness.js';

describe.each(executablePipelineScenarios)('$intentId $name', (scenario) => {
  it(
    'executes the planned scenario',
    async () => {
      await expect(runAcceptanceScenario(scenario)).resolves.toBeUndefined();
    },
    scenarioTimeoutMs(scenario.steps),
  );
});
