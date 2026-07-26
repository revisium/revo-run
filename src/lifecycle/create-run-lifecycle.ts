import { acquire } from './acquire.js';
import { claim } from './claim.js';
import { discover } from './discover.js';
import { renewLease } from './renew-lease.js';
import type { RunLifecycleDependencies } from './run-lifecycle-dependencies.js';
import type { RunLifecycle } from './run-lifecycle.js';
import { verifyAndStart } from './verify-and-start.js';
import { writeHandoff } from './write-handoff.js';

export const createRunLifecycle = (dependencies: RunLifecycleDependencies): RunLifecycle => {
  const lifecycle: RunLifecycle = {
    acquire: (request) => acquire(dependencies.store, request),
    claim: (request) => claim(dependencies.store, request),
    discover: (request) => discover(dependencies.store, request),
    renewLease: (request) => renewLease(dependencies.store, request),
    verifyAndStart: (request) =>
      verifyAndStart(dependencies.store, dependencies.executors, request),
    writeHandoff: (request) => writeHandoff(dependencies.store, request),
  };
  return Object.freeze(lifecycle);
};
