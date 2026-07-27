import type { ExecutionPlanPin } from '../spec/index.js';
import type { ExecutionPlanSourceResult } from './execution-plan-source-result.js';

export interface ExecutionPlanSource {
  /**
   * Loads only the immutable package-owned document matching every pin
   * component. Implementations must not fall back to another revision.
   */
  loadExact(pin: ExecutionPlanPin): Promise<ExecutionPlanSourceResult>;
}
