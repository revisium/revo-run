import type {
  AgentInvocationHandle,
  AgentInvocationSnapshot,
  AgentResultLookup,
  AgentBindingInput,
  AgentRuntimeStartInput,
  AgentTerminalResult,
  CancelInvocationResult,
  AgentRuntimePort,
} from '../../../src/composition/agent-port.js';

export interface FakeAgentPort {
  readonly port: AgentRuntimePort;
  readonly starts: readonly AgentRuntimeStartInput[];
  readonly lookups: readonly string[];
  readonly cancellations: readonly string[];
}

export const createFakeAgentPort = (
  resultFor: (input: AgentRuntimeStartInput) => AgentTerminalResult,
  options: Readonly<{ readonly deferCompletionUntilCancel?: boolean }> = {},
): FakeAgentPort => {
  const starts: AgentRuntimeStartInput[] = [];
  const lookups: string[] = [];
  const cancellations: string[] = [];
  const completed = new Map<string, AgentTerminalResult>();
  const pending = new Map<
    string,
    Readonly<{ readonly input: AgentRuntimeStartInput; readonly result: AgentTerminalResult }>
  >();
  const port: AgentRuntimePort = {
    initialize: async () => undefined,
    prepareBinding: async (_input: AgentBindingInput) => {
      throw new Error('Private test agent port does not prepare new bindings.');
    },
    start: async (input) => {
      starts.push(input);
      const result = resultFor(input);
      if (options.deferCompletionUntilCancel) {
        pending.set(input.invocationId, { input, result });
      } else {
        completed.set(input.invocationId, result);
      }
      const handle: AgentInvocationHandle = {
        invocationId: input.invocationId,
        pin: result.pin,
        result: async () => result,
        cancel: async (): Promise<CancelInvocationResult> => ({
          state: 'already_completed',
          result,
        }),
      };
      return Object.freeze({ status: 'accepted', handle });
    },
    getResult: (invocationId): AgentResultLookup => {
      lookups.push(invocationId);
      const result = completed.get(invocationId);
      if (result !== undefined) {
        return { state: 'completed', result };
      }
      const active = pending.get(invocationId);
      if (active === undefined) {
        return { state: 'unknown' };
      }
      const invocation: AgentInvocationSnapshot = {
        invocationId,
        pin: active.result.pin,
        status: 'running',
      };
      return { state: 'running', invocation };
    },
    cancel: async (invocationId): Promise<CancelInvocationResult> => {
      cancellations.push(invocationId);
      const result = completed.get(invocationId);
      if (result !== undefined) {
        return { state: 'already_completed', result };
      }
      const active = pending.get(invocationId);
      if (active === undefined) {
        return { state: 'unknown' };
      }
      pending.delete(invocationId);
      completed.set(invocationId, active.result);
      return { state: 'already_completed', result: active.result };
    },
    shutdown: async () => undefined,
  };
  return Object.freeze({ port, starts, lookups, cancellations });
};
