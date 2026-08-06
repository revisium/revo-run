import { describe, expect, it } from 'vitest';

import { runAcceptanceScenario } from '../support/acceptance/run-acceptance-scenario.js';
import { implementedPipelineScenarios } from './implemented-scenarios.js';

describe.each(implementedPipelineScenarios)('$name', (scenario) => {
  it('executes the planned scenario', async () => {
    await expect(runAcceptanceScenario(scenario)).resolves.toBeUndefined();
  });
});
