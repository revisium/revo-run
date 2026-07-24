import type { ExecutorConfigurationDigest } from './executor-configuration-digest.js';
import type { JsonValue } from './json-value.js';

export interface ExecutorConfigurationSnapshot {
  readonly configuration: JsonValue;
  readonly digest: ExecutorConfigurationDigest;
}
