import type { JsonValue } from './json-value.js';
import type { RunArtifactReference } from './run-artifact-reference.js';

export type RunOutputPayload =
  | {
      readonly kind: 'json';
      readonly value: JsonValue;
    }
  | {
      readonly kind: 'artifact';
      readonly artifact: RunArtifactReference;
    };
