import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import {
  AgentManagerError,
  createAgentManager,
  type ActiveInvocationSnapshot,
  type ActiveInvocationStateSink,
  type AgentManager,
  type StartAgentInvocation,
} from '@revisium/revo-agent-runtime';
import type { WorkspaceResolver } from '@revisium/revo-scripts';
import { Check } from 'typebox/value';

import { cloneFrozenJson } from '../../../contracts/json.js';
import { RunManagerError } from '../../../contracts/run-manager-error.js';
import type {
  AgentBindingInput,
  AgentInvocationHandle,
  AgentRuntimePort,
  AgentRuntimeStartInput,
  AgentStartContext,
  AgentStartOutcome,
  AgentTerminalResult,
  CancelInvocationResult,
  PreparedAgentBinding,
} from '../../agent-port.js';
import {
  CODEX_AGENT_DEFINITION,
  CODEX_AGENT_REF,
  CodexParametersSchema,
  CodexPermissionsSchema,
} from './codex-definition.js';
import {
  sanitizeAgentResultLookup,
  sanitizeAgentTerminalResult,
  sanitizeCancelResult,
} from './codex-result-mapper.js';
import { isExpectedHandle, rejectedStart, unknownStart } from './codex-start-outcome.js';

const inheritedEnvironmentNames = Object.freeze(['PATH', 'TMPDIR', 'LANG', 'LC_ALL']);
const secretEnvironmentNames = Object.freeze(['HOME', 'CODEX_HOME']);
const logicalWorkspaceRefPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

interface PendingStart {
  readonly controller: AbortController;
  readonly settlement: Promise<void>;
  settle(): void;
}

interface InvocationSanitization {
  secretValues: readonly string[] | undefined;
  terminal: AgentTerminalResult | undefined;
  terminalPromise: Promise<AgentTerminalResult> | undefined;
}

const createPendingStart = (): PendingStart => {
  const controller = new AbortController();
  let settle = (): void => undefined;
  const settlement = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return Object.freeze({ controller, settlement, settle });
};

const isSupportedCodexBinding = (input: AgentBindingInput): boolean =>
  input.definition.id === CODEX_AGENT_REF.id &&
  input.definition.version === CODEX_AGENT_REF.version &&
  input.credentials === undefined &&
  logicalWorkspaceRefPattern.test(input.workspaceRef) &&
  Check(CodexParametersSchema, input.parameters) &&
  typeof input.parameters.model === 'string' &&
  modelPattern.test(input.parameters.model) &&
  Check(CodexPermissionsSchema, input.permissions);

const prepareBinding = (
  input: AgentBindingInput,
  descriptor: NonNullable<ReturnType<AgentManager['getAgent']>>,
): PreparedAgentBinding =>
  Object.freeze({
    schemaVersion: 'prepared-agent-binding/v1',
    pin: Object.freeze({
      agentId: descriptor.agent.id,
      agentVersion: descriptor.agent.version,
      definitionDigest: descriptor.definitionDigest,
    }),
    parameters: cloneFrozenJson(input.parameters),
    permissions: cloneFrozenJson(input.permissions),
    workspaceRef: input.workspaceRef,
  });

const acquireWorkspace = async (
  workspaces: WorkspaceResolver,
  workspaceRef: string,
  signal: AbortSignal,
): Promise<string> => {
  const allocation = await workspaces.acquire(workspaceRef, { signal });
  if (signal.aborted || !isAbsolute(allocation.absolutePath)) {
    throw new RunManagerError('agent_runtime_unavailable');
  }
  const metadata = await stat(allocation.absolutePath);
  if (signal.aborted || !metadata.isDirectory()) {
    throw new RunManagerError('agent_runtime_unavailable');
  }
  return allocation.absolutePath;
};

const outputDirectory = (workspace: string, invocationId: string): string => {
  const digest = createHash('sha256').update(invocationId).digest('hex');
  return join(dirname(workspace), `.revo-agent-${digest}`);
};

const inheritedEnvironment = (): readonly string[] =>
  inheritedEnvironmentNames.filter((name) => process.env[name] !== undefined);

const captureInvocationSecrets = (): Readonly<{
  secrets: Readonly<Record<string, string>>;
  values: readonly string[];
}> => {
  const secrets = Object.freeze(
    Object.fromEntries(
      secretEnvironmentNames.flatMap((name) => {
        const value = process.env[name];
        return value === undefined || value.length === 0 ? [] : [[name, value]];
      }),
    ),
  );
  return Object.freeze({
    secrets,
    values: Object.freeze(Object.values(secrets)),
  });
};

const runtimeStart = (input: AgentRuntimeStartInput, workspace: string): StartAgentInvocation => ({
  invocationId: input.invocationId,
  agent: {
    id: input.binding.pin.agentId,
    version: input.binding.pin.agentVersion,
  },
  prompt: input.prompt,
  workspace: { directory: workspace },
  parameters: input.binding.parameters,
  permissions: input.binding.permissions,
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  result: {
    schema: Object.hasOwn(input.result.schema, '$schema')
      ? input.result.schema
      : {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          ...input.result.schema,
        },
  },
  ...(input.limits === undefined ? {} : { limits: input.limits }),
  output: { directory: outputDirectory(workspace, input.invocationId) },
});

const isCancellationFault = (error: AgentManagerError, signal: AbortSignal): boolean =>
  signal.aborted ||
  error.fault.code === 'revo.agent.cancelled' ||
  error.fault.code === 'revo.agent.manager_closed';

export const createCodexAgentRuntimePort = (
  workspaces: WorkspaceResolver,
  activeStateSink: ActiveInvocationStateSink,
): AgentRuntimePort => {
  const manager = createAgentManager({
    definitions: [CODEX_AGENT_DEFINITION],
    activeStateSink,
    redaction: { secrets: [] },
  });
  const pending = new Map<string, PendingStart>();
  const sanitization = new Map<string, InvocationSanitization>();
  let closing = false;

  const releaseSecrets = (entry: InvocationSanitization): void => {
    entry.secretValues = undefined;
  };

  const sanitizedTerminal = (
    entry: InvocationSanitization,
    result: Parameters<typeof sanitizeAgentTerminalResult>[0],
  ): AgentTerminalResult => {
    if (entry.terminal !== undefined) {
      return entry.terminal;
    }
    const terminal = sanitizeAgentTerminalResult(result, entry.secretValues ?? []);
    entry.terminal = terminal;
    releaseSecrets(entry);
    return terminal;
  };

  const pruneSanitization = (): void => {
    const retained = new Set(manager.listInvocations().map(({ invocationId }) => invocationId));
    for (const [invocationId, entry] of sanitization) {
      if (!retained.has(invocationId)) {
        releaseSecrets(entry);
        sanitization.delete(invocationId);
      }
    }
  };

  const sanitizedCancellation = (
    entry: InvocationSanitization,
    result: Awaited<ReturnType<AgentManager['cancel']>>,
  ): CancelInvocationResult =>
    result.state === 'already_completed'
      ? Object.freeze({ state: result.state, result: sanitizedTerminal(entry, result.result) })
      : sanitizeCancelResult(result);

  const sanitizedHandle = (
    handle: Awaited<ReturnType<AgentManager['start']>>,
    entry: InvocationSanitization,
  ): AgentInvocationHandle => {
    const terminalPromise = handle.result().then(
      (result) => sanitizedTerminal(entry, result),
      (error: unknown) => {
        releaseSecrets(entry);
        throw error;
      },
    );
    void terminalPromise.catch(() => undefined);
    entry.terminalPromise = terminalPromise;
    return Object.freeze({
      invocationId: handle.invocationId,
      pin: Object.freeze({ ...handle.pin }),
      result: async () => await terminalPromise,
      cancel: async (reason?: string) => sanitizedCancellation(entry, await handle.cancel(reason)),
    });
  };

  const start = async (
    input: AgentRuntimeStartInput,
    context?: AgentStartContext,
  ): Promise<AgentStartOutcome> => {
    if (
      closing ||
      input.binding.pin.agentId !== CODEX_AGENT_REF.id ||
      input.binding.pin.agentVersion !== CODEX_AGENT_REF.version
    ) {
      return rejectedStart(input, closing);
    }
    const descriptor = manager.getAgent(CODEX_AGENT_REF);
    if (descriptor?.definitionDigest !== input.binding.pin.definitionDigest) {
      return unknownStart();
    }
    const owned = createPendingStart();
    if (pending.has(input.invocationId)) {
      return unknownStart();
    }
    pending.set(input.invocationId, owned);
    const signal =
      context?.signal === undefined
        ? owned.controller.signal
        : AbortSignal.any([owned.controller.signal, context.signal]);
    try {
      let workspace: string;
      try {
        workspace = await acquireWorkspace(workspaces, input.binding.workspaceRef, signal);
      } catch {
        return rejectedStart(input, signal.aborted || closing);
      }
      if (signal.aborted || closing) {
        return rejectedStart(input, true);
      }
      let handle;
      const invocationSecrets = captureInvocationSecrets();
      try {
        handle = await manager.start(runtimeStart(input, workspace), {
          signal,
          environment: {
            inherit: inheritedEnvironment(),
            secrets: invocationSecrets.secrets,
          },
        });
      } catch (error) {
        return error instanceof AgentManagerError
          ? rejectedStart(input, isCancellationFault(error, signal))
          : unknownStart();
      }
      if (!isExpectedHandle(input, handle)) {
        return unknownStart();
      }
      const entry: InvocationSanitization = {
        secretValues: invocationSecrets.values,
        terminal: undefined,
        terminalPromise: undefined,
      };
      sanitization.set(input.invocationId, entry);
      pruneSanitization();
      return Object.freeze({
        status: 'accepted',
        handle: sanitizedHandle(handle, entry),
      });
    } finally {
      if (pending.get(input.invocationId) === owned) {
        pending.delete(input.invocationId);
      }
      owned.settle();
    }
  };

  return Object.freeze({
    initialize: async (snapshots: readonly ActiveInvocationSnapshot[]) => {
      await manager.initialize(snapshots);
    },
    prepareBinding: async (input: AgentBindingInput) => {
      if (process.platform !== 'linux' || !isSupportedCodexBinding(input)) {
        throw new RunManagerError('agent_runtime_unavailable');
      }
      const descriptor = manager.getAgent(input.definition);
      if (descriptor === undefined) {
        throw new RunManagerError('agent_runtime_unavailable');
      }
      return prepareBinding(input, descriptor);
    },
    start,
    getResult: (invocationId: string) => {
      const entry = sanitization.get(invocationId);
      const lookup = manager.getResult(invocationId);
      if (lookup.state === 'unknown') {
        if (entry !== undefined) {
          releaseSecrets(entry);
          sanitization.delete(invocationId);
        }
        pruneSanitization();
        return Object.freeze({ state: lookup.state });
      }
      if (lookup.state === 'completed' && entry?.terminal !== undefined) {
        pruneSanitization();
        return Object.freeze({ state: lookup.state, result: entry.terminal });
      }
      if (lookup.state === 'completed' && entry !== undefined) {
        return Object.freeze({
          state: lookup.state,
          result: sanitizedTerminal(entry, lookup.result),
        });
      }
      pruneSanitization();
      return sanitizeAgentResultLookup(lookup, entry?.secretValues ?? []);
    },
    cancel: async (invocationId: string, reason?: string) => {
      const activePending = pending.get(invocationId);
      if (activePending !== undefined) {
        activePending.controller.abort();
        await activePending.settlement;
      }
      const entry = sanitization.get(invocationId);
      const result = await manager.cancel(invocationId, reason);
      if (entry === undefined) {
        return sanitizeCancelResult(result);
      }
      const sanitized = sanitizedCancellation(entry, result);
      if (sanitized.state === 'unknown') {
        releaseSecrets(entry);
        sanitization.delete(invocationId);
      }
      pruneSanitization();
      return sanitized;
    },
    shutdown: async (reason?: string) => {
      closing = true;
      const settling = [...pending.values()].map((entry) => {
        entry.controller.abort();
        return entry.settlement;
      });
      await Promise.all(settling);
      try {
        await manager.shutdown(reason);
      } finally {
        for (const entry of sanitization.values()) {
          releaseSecrets(entry);
        }
        sanitization.clear();
      }
    },
  });
};
