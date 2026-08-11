import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { PositiveSafeIntegerSchema } from '../schema-primitives.js';
import { RunIdSchema, runIdPattern } from './run-id.js';

const RunIdPattern = new RegExp(runIdPattern);

export const RunEventCursorSchema = Type.Refine(
  Type.TemplateLiteral([RunIdSchema, Type.Literal(':'), PositiveSafeIntegerSchema]),
  (value) => {
    const separator = value.lastIndexOf(':');
    const runId = value.slice(0, separator);
    const encodedSequence = value.slice(separator + 1);
    const sequence = Number(encodedSequence);
    return (
      RunIdPattern.test(runId) &&
      Number.isSafeInteger(sequence) &&
      sequence > 0 &&
      encodedSequence === String(sequence)
    );
  },
);

export type RunEventCursor = DeepReadonly<Type.Static<typeof RunEventCursorSchema>>;
