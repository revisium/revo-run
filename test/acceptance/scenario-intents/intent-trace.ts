import type { RunScenario } from '../../dsl/run-scenario.js';

export type IntentTrace = Pick<RunScenario, 'intentId' | 'category' | 'name'>;
