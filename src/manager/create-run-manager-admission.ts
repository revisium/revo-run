import { snapshotExecutionPlanPin } from '../policy/index.js';
import type { ExecutionPlanPin, JsonValue, RunManagerSnapshot } from '../spec/index.js';

export const createRunManagerAdmission = (
  id: string,
  planPin: ExecutionPlanPin,
  input: JsonValue,
): RunManagerSnapshot =>
  Object.freeze({
    error: null,
    id,
    input,
    planPin: snapshotExecutionPlanPin(planPin),
    result: null,
    status: 'pending',
  });
