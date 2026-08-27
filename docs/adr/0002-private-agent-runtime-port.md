# ADR 0002: Private agent-runtime port for RN1

## Decision

RN1 keeps agent execution behind the unexported `AgentRuntimePort` in
`src/composition/agent-port.ts`. It is a testable internal boundary, not a
consumer option and not a substitute for `@revisium/revo-agent-runtime`.

The frozen port surface is deliberately small and exact:

```ts
interface AgentRuntimePort {
  initialize(snapshots: readonly ActiveInvocationSnapshot[]): Promise<void>;
  prepareBinding(input: AgentBindingInput): Promise<PreparedAgentBinding>;
  start(input: StartAgentInvocation, context?: AgentStartContext): Promise<AgentInvocationHandle>;
  getResult(invocationId: string): AgentResultLookup;
  cancel(invocationId: string, reason?: string): Promise<CancelInvocationResult>;
  shutdown(reason?: string): Promise<void>;
}
```

`AgentExecutionPin` is the identity returned by every handle/result/lookup.
`StartAgentInvocation` contains the agent reference, prompt, workspace,
parameters, permissions, output/result contract and optional limits. The result
is a closed succeeded/failed/cancelled/timed-out union with process output-file
metadata and a typed fault. `getResult` is synchronous and returns only
running/completed/unknown; it does not start work or infer an outcome.

Production composes only `unavailableAgentPort`: only `initialize([])` and shutdown
succeed, while a non-empty recovery initialization, prepare/start/lookup/cancel throw the exact closed public error
`agent_runtime_unavailable` with empty details. It is therefore impossible for
the public manager, including an installed package consumer, to inject an
agent fake or choose a runtime mode.

## Consequences

- Test fakes remain under `test/support/agent-runtime/` and are never imported
  by production source, exported from the root, or packed.
- Tests can exercise the durable host's stable invocation identity, lookup and
  cancellation paths without claiming that RN1 ships an agent adapter.
- An approved future adapter may implement this port against a stable
  `@revisium/revo-agent-runtime` root API; it must not change the public
  manager model or move pipeline control-flow into `revo-run`.
- Agent-bearing public admission stays fail-closed until that separate work is
  approved.
