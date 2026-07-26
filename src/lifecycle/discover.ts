import { snapshotLeasePolicy } from '../policy/index.js';
import type { RunStore } from '../storage/index.js';
import type { LifecycleDiscoveryRequest } from './lifecycle-discovery-request.js';
import type { LifecycleDiscoveryResult } from './lifecycle-discovery-result.js';
import { lifecycleSupport } from './lifecycle-support.js';

const { boundedString, invalid, mapCandidate, mapDiscoveryCursor } = lifecycleSupport;
import { lifecycleValidation } from './lifecycle-validation.js';

export const discover = async (
  store: RunStore,
  request: LifecycleDiscoveryRequest,
): Promise<LifecycleDiscoveryResult> => {
  try {
    request = lifecycleValidation.discoveryRequest(request);
    const lease =
      request.renewal === null
        ? null
        : {
            leasePolicy: snapshotLeasePolicy(request.renewal.leasePolicy),
            managerIncarnationId: boundedString(request.renewal.managerIncarnationId),
          };
    const result = await store.discover({
      kinds: Object.freeze([...request.kinds]),
      limit: request.limit,
      renewal: lease,
      scan:
        request.scan.kind === 'start'
          ? Object.freeze({ kind: 'start' })
          : Object.freeze({ cursor: request.scan.cursor, kind: 'continue' }),
    });
    if (result.kind === 'invalid_input') return invalid();
    return Object.freeze({
      kind: 'page',
      page: Object.freeze({
        highWatermark: result.page.highWatermark,
        items: Object.freeze(result.page.items.map(mapCandidate)),
        next: mapDiscoveryCursor(result.page.next),
      }),
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid();
    throw error;
  }
};
