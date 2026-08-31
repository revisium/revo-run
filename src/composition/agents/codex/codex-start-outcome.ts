import type { AgentInvocationHandle as RuntimeInvocationHandle } from '@revisium/revo-agent-runtime';

import type {
  AgentRuntimeStartInput,
  AgentStartOutcome,
  AgentTerminalResult,
} from '../../agent-port.js';

const genericFailure = (input: AgentRuntimeStartInput): AgentTerminalResult =>
  Object.freeze({
    schemaVersion: 'agent-terminal-result/v1',
    invocationId: input.invocationId,
    pin: Object.freeze({ ...input.binding.pin }),
    status: 'failed',
    error: Object.freeze({
      code: 'revo.run.execution_failed',
      message: 'Agent execution failed.',
    }),
  });

const cancelled = (input: AgentRuntimeStartInput): AgentTerminalResult =>
  Object.freeze({
    schemaVersion: 'agent-terminal-result/v1',
    invocationId: input.invocationId,
    pin: Object.freeze({ ...input.binding.pin }),
    status: 'cancelled',
  });

export const rejectedStart = (
  input: AgentRuntimeStartInput,
  isCancelled: boolean,
): AgentStartOutcome =>
  Object.freeze({
    status: 'rejected',
    result: isCancelled ? cancelled(input) : genericFailure(input),
  });

export const unknownStart = (): AgentStartOutcome => Object.freeze({ status: 'unknown' });

export const isExpectedHandle = (
  input: AgentRuntimeStartInput,
  handle: RuntimeInvocationHandle,
): boolean =>
  handle.invocationId === input.invocationId &&
  handle.pin.agentId === input.binding.pin.agentId &&
  handle.pin.agentVersion === input.binding.pin.agentVersion &&
  handle.pin.definitionDigest === input.binding.pin.definitionDigest;
