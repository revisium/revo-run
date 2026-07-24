import type { ExecutorConfigurationSnapshot } from '../spec/index.js';
import { digestCanonicalJson } from './canonical-json/digest-canonical-json.js';
import { snapshotPortableJsonValue } from './snapshot-portable-json-value.js';

export const snapshotExecutorConfiguration = (value: unknown): ExecutorConfigurationSnapshot => {
  const configuration = snapshotPortableJsonValue(value);
  return Object.freeze({
    configuration,
    digest: digestCanonicalJson(configuration),
  });
};
