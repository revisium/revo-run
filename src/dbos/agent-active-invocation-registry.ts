import { DBOS, type DBOSExternalState } from '@dbos-inc/dbos-sdk';
import type {
  ActiveInvocationSnapshot,
  ActiveInvocationStateSink,
} from '@revisium/revo-agent-runtime';

type ActiveStateOperationContext = Parameters<ActiveInvocationStateSink['save']>[1];

const registrySchemaVersion = 'agent-active-invocation-registry/v1';
const registryIdentity = Object.freeze({
  service: 'revo-run',
  workflowFnName: 'agent-active-invocation-registry-v1',
  key: 'active-invocations',
});

interface RegistryDocument {
  readonly schemaVersion: typeof registrySchemaVersion;
  readonly revision: number;
  readonly snapshots: readonly ActiveInvocationSnapshot[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isPin = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ['agentId', 'agentVersion', 'definitionDigest']) &&
  isBoundedString(value.agentId, 256) &&
  isBoundedString(value.agentVersion, 256) &&
  isBoundedString(value.definitionDigest, 64) &&
  /^[a-f0-9]{64}$/u.test(value.definitionDigest);

const isProcessIdentity = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ['pid', 'processGroupId', 'fingerprint', 'startedAt']) &&
  isPositiveInteger(value.pid) &&
  isPositiveInteger(value.processGroupId) &&
  isBoundedString(value.fingerprint, 512) &&
  isBoundedString(value.startedAt, 64) &&
  Number.isFinite(Date.parse(value.startedAt));

const isSnapshot = (value: unknown): value is ActiveInvocationSnapshot =>
  isRecord(value) &&
  hasExactKeys(value, ['invocationId', 'pin', 'state', 'process']) &&
  isBoundedString(value.invocationId, 256) &&
  isPin(value.pin) &&
  (value.state === 'running' || value.state === 'cancelling') &&
  isProcessIdentity(value.process);

const isRegistryDocument = (value: unknown): value is RegistryDocument =>
  isRecord(value) &&
  hasExactKeys(value, ['schemaVersion', 'revision', 'snapshots']) &&
  value.schemaVersion === registrySchemaVersion &&
  typeof value.revision === 'number' &&
  Number.isSafeInteger(value.revision) &&
  value.revision >= 0 &&
  Array.isArray(value.snapshots) &&
  value.snapshots.every(isSnapshot) &&
  new Set(value.snapshots.map((snapshot) => snapshot.invocationId)).size === value.snapshots.length;

const cloneSnapshot = (snapshot: ActiveInvocationSnapshot): ActiveInvocationSnapshot =>
  Object.freeze({
    invocationId: snapshot.invocationId,
    pin: Object.freeze({ ...snapshot.pin }),
    state: snapshot.state,
    process: Object.freeze({ ...snapshot.process }),
  });

const cloneDocument = (document: RegistryDocument): RegistryDocument =>
  Object.freeze({
    schemaVersion: registrySchemaVersion,
    revision: document.revision,
    snapshots: Object.freeze(document.snapshots.map(cloneSnapshot)),
  });

const parseDocument = (state: DBOSExternalState | undefined): RegistryDocument => {
  if (state === undefined) {
    return Object.freeze({ schemaVersion: registrySchemaVersion, revision: 0, snapshots: [] });
  }
  if (
    state.service !== registryIdentity.service ||
    state.workflowFnName !== registryIdentity.workflowFnName ||
    state.key !== registryIdentity.key ||
    typeof state.value !== 'string'
  ) {
    throw new Error('Agent active-invocation registry identity is invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(state.value) as unknown;
  } catch {
    throw new Error('Agent active-invocation registry JSON is invalid.');
  }
  if (!isRegistryDocument(value) || state.updateSeq !== BigInt(value.revision)) {
    throw new Error('Agent active-invocation registry document is invalid.');
  }
  return cloneDocument(value);
};

let current = Object.freeze<RegistryDocument>({
  schemaVersion: registrySchemaVersion,
  revision: 0,
  snapshots: [],
});
let initialized = false;
let mutationTail = Promise.resolve();

const writeDocument = async (document: RegistryDocument): Promise<void> => {
  const value = JSON.stringify(document);
  const stored = await DBOS.upsertEventDispatchState({
    ...registryIdentity,
    value,
    updateSeq: BigInt(document.revision),
  });
  if (stored.updateSeq !== BigInt(document.revision) || stored.value !== value) {
    throw new Error('Agent active-invocation registry write lost version ownership.');
  }
  current = cloneDocument(document);
};

const enqueueMutation = async (
  context: ActiveStateOperationContext,
  mutate: (snapshots: Map<string, ActiveInvocationSnapshot>) => void,
): Promise<void> => {
  const operation = mutationTail.then(async () => {
    if (!initialized || context.signal.aborted) {
      throw new Error('Agent active-invocation registry is unavailable.');
    }
    const snapshots = new Map(
      current.snapshots.map((snapshot) => [snapshot.invocationId, cloneSnapshot(snapshot)]),
    );
    mutate(snapshots);
    await writeDocument(
      Object.freeze({
        schemaVersion: registrySchemaVersion,
        revision: current.revision + 1,
        snapshots: Object.freeze(
          [...snapshots.values()].toSorted((left, right) =>
            left.invocationId.localeCompare(right.invocationId),
          ),
        ),
      }),
    );
  });
  mutationTail = operation.catch(() => undefined);
  await operation;
};

export const agentActiveInvocationStateSink: ActiveInvocationStateSink = Object.freeze({
  save: async (snapshot: ActiveInvocationSnapshot, context: ActiveStateOperationContext) => {
    const copied = cloneSnapshot(snapshot);
    await enqueueMutation(context, (snapshots) => snapshots.set(copied.invocationId, copied));
  },
  remove: async (invocationId: string, context: ActiveStateOperationContext) => {
    await enqueueMutation(context, (snapshots) => {
      snapshots.delete(invocationId);
    });
  },
});

export const loadAgentActiveInvocationSnapshots = async (): Promise<
  readonly ActiveInvocationSnapshot[]
> => {
  await mutationTail;
  current = parseDocument(
    await DBOS.getEventDispatchState(
      registryIdentity.service,
      registryIdentity.workflowFnName,
      registryIdentity.key,
    ),
  );
  initialized = true;
  return current.snapshots;
};
