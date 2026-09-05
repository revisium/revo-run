import type { AgentStartContext as RuntimeStartContext } from '@revisium/revo-agent-runtime';
import type { CredentialResolver } from '@revisium/revo-scripts';

import type { CreateRunManagerOptions } from '../../../contracts/manager.js';
import type { PreparedAgentBinding } from '../../agent-port.js';

type CredentialLease = Awaited<ReturnType<CredentialResolver['acquire']>>;

export interface CredentialOwner {
  readonly leases: readonly CredentialLease[];
  readonly cleanupState: 'active' | 'disposing' | 'disposed' | 'failed';
  readonly cleanupFailure?: unknown;
  dispose(): Promise<void>;
}

const contextFor = (signal: AbortSignal) => ({ signal });

export const combineErrors = (errors: readonly unknown[], message: string): unknown => {
  if (errors.length === 1) {
    return errors[0];
  }
  return new AggregateError(errors, message);
};

const disposeLeases = async (leases: readonly CredentialLease[]): Promise<void> => {
  const settled = await Promise.allSettled(
    leases.map((lease) => Promise.resolve().then(() => lease.dispose())),
  );
  const failures: unknown[] = [];
  for (const result of settled) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw combineErrors(failures, 'Credential lease disposal failed.');
  }
};

export const acquireCredentials = async (
  binding: PreparedAgentBinding,
  credentials: CreateRunManagerOptions['host']['credentials'],
  signal: AbortSignal,
): Promise<CredentialOwner> => {
  const aliases = [...new Set(Object.values(binding.credentials).map(({ alias }) => alias))];
  const pending = aliases.map((alias) =>
    Promise.resolve().then(() => credentials.acquire(alias, contextFor(signal))),
  );
  const settled = await Promise.allSettled(pending);
  const acquired: CredentialLease[] = [];
  const failures: unknown[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(result.reason);
      return;
    }
    acquired.push(result.value);
    const alias = aliases[index];
    if (result.value.alias !== alias) {
      failures.push(
        new Error(`Credential resolver returned alias ${result.value.alias} for ${alias}.`),
      );
    }
  });
  if (failures.length > 0) {
    try {
      await disposeLeases(acquired);
    } catch (cleanupError) {
      throw combineErrors(
        [...failures, cleanupError],
        'Credential acquisition and cleanup failed.',
      );
    }
    throw combineErrors(failures, 'Credential acquisition failed.');
  }
  let disposePromise: Promise<void> | undefined;
  let cleanupState: CredentialOwner['cleanupState'] = 'active';
  let cleanupFailure: unknown;
  const owner: CredentialOwner = {
    leases: acquired,
    get cleanupState() {
      return cleanupState;
    },
    get cleanupFailure() {
      return cleanupFailure;
    },
    dispose(): Promise<void> {
      if (disposePromise === undefined) {
        cleanupState = 'disposing';
        disposePromise = disposeLeases(owner.leases).then(
          () => {
            cleanupState = 'disposed';
          },
          (error: unknown) => {
            cleanupState = 'failed';
            cleanupFailure = error;
            throw error;
          },
        );
      }
      return disposePromise;
    },
  };
  return owner;
};

export const runtimeEnvironment = (
  owner: CredentialOwner,
  binding: PreparedAgentBinding,
  signal: AbortSignal,
): RuntimeStartContext => {
  const secrets: Record<string, string> = {};
  for (const [environmentVariable, descriptor] of Object.entries(binding.credentials)) {
    const lease = owner.leases.find((candidate) => candidate.alias === descriptor.alias);
    if (lease !== undefined) {
      secrets[environmentVariable] = lease.secret;
    }
  }
  return {
    signal,
    environment: {
      inherit: ['CLAUDE_CODE_EXECUTABLE', 'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'].filter(
        (name) => process.env[name] !== undefined,
      ),
      variables: {},
      secrets,
    },
  };
};
