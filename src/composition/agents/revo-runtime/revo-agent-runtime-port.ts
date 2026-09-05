import { type AgentDefinitionInput, type AgentManager } from '@revisium/revo-agent-runtime';

import type { CreateRunManagerOptions } from '../../../contracts/manager.js';
import type { AgentAttemptExecutionPort, AgentInvocationHandle } from '../../agent-port.js';
import { createBindingPreparer, indexAgentDefinitions } from './binding-preparer.js';
import {
  acquireCredentials,
  combineErrors,
  runtimeEnvironment,
  type CredentialOwner,
} from './credential-leases.js';
import { mapCancel, mapLookup, mapResult } from './result-mapper.js';
import { runtimeRequest } from './runtime-request.js';

interface PendingStart {
  readonly controller: AbortController;
  readonly settlement: Promise<void>;
  settle(): void;
}

const createPendingStart = (): PendingStart => {
  const controller = new AbortController();
  let settle = (): void => undefined;
  const settlement = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return Object.freeze({ controller, settlement, settle });
};

export interface CreateAgentAttemptExecutionAdapterOptions {
  readonly manager: Pick<AgentManager, 'cancel' | 'getAgent' | 'getResult' | 'start'>;
  readonly definitions: readonly AgentDefinitionInput[];
  readonly host: CreateRunManagerOptions['host'];
}

export interface AgentAttemptExecutionAdapter extends AgentAttemptExecutionPort {
  shutdown(reason?: string): Promise<void>;
}

export const createAgentAttemptExecutionAdapter = (
  options: CreateAgentAttemptExecutionAdapterOptions,
): AgentAttemptExecutionAdapter => {
  const { manager } = options;
  const definitions = indexAgentDefinitions(options.definitions);
  const prepareBinding = createBindingPreparer(definitions, manager, options.host);
  type InvocationCredentialOwner = {
    readonly invocationId: string;
    readonly pin: AgentInvocationHandle['pin'];
    readonly credentials: CredentialOwner;
    readonly cleanupState: CredentialOwner['cleanupState'];
    readonly cleanupFailure?: unknown;
    dispose(): Promise<void>;
  };
  const owners = new Map<string, InvocationCredentialOwner>();
  const disposeOwner = async (owner: InvocationCredentialOwner): Promise<void> => {
    await owner.dispose();
    owners.delete(owner.invocationId);
  };
  const pending = new Map<string, PendingStart>();
  let closing = false;

  const port: AgentAttemptExecutionAdapter = {
    prepareBinding,
    start: async (input, context) => {
      if (closing || pending.has(input.invocationId) || owners.has(input.invocationId)) {
        return { status: 'unknown' };
      }
      const owned = createPendingStart();
      pending.set(input.invocationId, owned);
      const signal =
        context?.signal === undefined
          ? owned.controller.signal
          : AbortSignal.any([owned.controller.signal, context.signal]);
      let allocation;
      let owner: InvocationCredentialOwner | undefined;
      try {
        const descriptor = manager.getAgent({
          id: input.binding.pin.agentId,
          version: input.binding.pin.agentVersion,
        });
        if (descriptor?.definitionDigest !== input.binding.pin.definitionDigest) {
          return { status: 'unknown' };
        }
        allocation = await options.host.workspaces.acquire(input.binding.workspaceRef, { signal });
        const acquiredOwner = await acquireCredentials(
          input.binding,
          options.host.credentials,
          signal,
        );
        const invocationOwner: InvocationCredentialOwner = {
          invocationId: input.invocationId,
          pin: input.binding.pin,
          credentials: acquiredOwner,
          get cleanupState() {
            return acquiredOwner.cleanupState;
          },
          get cleanupFailure() {
            return acquiredOwner.cleanupFailure;
          },
          dispose: () => acquiredOwner.dispose(),
        };
        owner = invocationOwner;
        owners.set(invocationOwner.invocationId, invocationOwner);
        const handle = await manager.start(runtimeRequest(input, allocation.absolutePath), {
          signal,
          ...runtimeEnvironment(invocationOwner.credentials, input.binding, signal),
        });
        const result = (async () => {
          try {
            return mapResult(await handle.result());
          } finally {
            await disposeOwner(invocationOwner);
          }
        })();
        void result.catch(() => undefined);
        const wrapped: AgentInvocationHandle = {
          invocationId: handle.invocationId,
          pin: handle.pin,
          result: async () => await result,
          cancel: async (reason?: string) => {
            const cancelled = mapCancel(await handle.cancel(reason));
            if (cancelled.state === 'already_completed') {
              await disposeOwner(invocationOwner);
            }
            return cancelled;
          },
        };
        return { status: 'accepted', handle: Object.freeze(wrapped) };
      } catch (error) {
        if (owner !== undefined) {
          try {
            await disposeOwner(owner);
          } catch (cleanupError) {
            throw combineErrors(
              [error, cleanupError],
              'Agent invocation and credential cleanup failed.',
            );
          }
        }
        if (signal.aborted) {
          return { status: 'unknown' };
        }
        throw error;
      } finally {
        if (pending.get(input.invocationId) === owned) {
          pending.delete(input.invocationId);
        }
        owned.settle();
      }
    },
    getResult: (invocationId) => {
      const owner = owners.get(invocationId);
      if (owner?.cleanupState === 'failed') {
        throw owner.cleanupFailure;
      }
      const rawLookup = manager.getResult(invocationId);
      if (owner !== undefined && rawLookup.state === 'completed') {
        return {
          state: 'running',
          invocation: { invocationId, pin: owner.pin, status: 'running' },
        };
      }
      return mapLookup(rawLookup);
    },
    cancel: async (invocationId, reason) => {
      const activePending = pending.get(invocationId);
      if (activePending !== undefined) {
        activePending.controller.abort();
        await activePending.settlement;
      }
      return mapCancel(await manager.cancel(invocationId, reason));
    },
    shutdown: async (_reason) => {
      closing = true;
      const settling = [...pending.values()].map((entry) => {
        entry.controller.abort();
        return entry.settlement;
      });
      const settlingResults = await Promise.allSettled(settling);
      const failures: unknown[] = [];
      for (const result of settlingResults) {
        if (result.status === 'rejected') {
          failures.push(result.reason);
        }
      }
      const cleanupResults = await Promise.allSettled(
        [...owners.values()].map((owner) => disposeOwner(owner)),
      );
      for (const result of cleanupResults) {
        if (result.status === 'rejected') {
          failures.push(result.reason);
        }
      }
      if (failures.length > 0) {
        throw combineErrors(failures, 'Agent runtime shutdown failed.');
      }
    },
  };
  return Object.freeze(port);
};
