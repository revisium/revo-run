import type {
  AgentInvocationHandle,
  AgentInvocationResult,
  AgentInvocationSnapshot,
  AgentResultLookup,
  AgentBindingInput,
  StartAgentInvocation,
  CancelInvocationResult,
  AgentRuntimePort,
} from '../../../src/composition/agent-port.js';

export interface FakeAgentPort {
  readonly port: AgentRuntimePort;
  readonly starts: readonly StartAgentInvocation[];
  readonly lookups: readonly string[];
  readonly cancellations: readonly string[];
}

export const createFakeAgentPort = (
  resultFor: (input: StartAgentInvocation) => AgentInvocationResult,
  options: Readonly<{ readonly deferCompletionUntilCancel?: boolean }> = {},
): FakeAgentPort => {
  const starts: StartAgentInvocation[] = [];
  const lookups: string[] = [];
  const cancellations: string[] = [];
  const completed = new Map<string, AgentInvocationResult>();
  const pending = new Map<
    string,
    Readonly<{ readonly input: StartAgentInvocation; readonly result: AgentInvocationResult }>
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
      return handle;
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
        acceptedAt: active.result.acceptedAt,
        ...(active.result.startedAt === undefined ? {} : { startedAt: active.result.startedAt }),
        outputDirectory: active.input.output.directory,
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
