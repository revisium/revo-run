# ADR 0002: Private agent-runtime port for RN1

## Status

Superseded by [ADR 0003](./0003-injected-agent-attempt-execution-port.md). This
document records the earlier RN1-owned runtime composition and is not the current
integration contract.

## Decision

RN1 keeps agent execution behind the unexported `AgentRuntimePort` in
`src/composition/agent-port.ts`. It is a testable internal boundary, not a
consumer option and not a substitute for `@revisium/revo-agent-runtime`.

The frozen port surface is deliberately small and exact:

```ts
interface AgentRuntimePort {
  initialize(snapshots: readonly ActiveInvocationSnapshot[]): Promise<void>;
  prepareBinding(input: AgentBindingInput): Promise<PreparedAgentBinding>;
  start(input: AgentRuntimeStartInput, context?: AgentStartContext): Promise<AgentInvocationHandle>;
  getResult(invocationId: string): AgentResultLookup;
  cancel(invocationId: string, reason?: string): Promise<CancelInvocationResult>;
  shutdown(reason?: string): Promise<void>;
}
```

`AgentExecutionPin` is the identity returned by every handle/result/lookup.
`AgentRuntimeStartInput` contains the admitted binding, prompt, result contract
and optional metadata/limits. The result is a closed
succeeded/failed/cancelled/timed-out union with a typed fault; runtime launch
evidence and output-file paths are deliberately not carried into durable
history. `getResult` is synchronous and returns only
running/completed/unknown; it does not start work or infer an outcome.

Production composes one private adapter over the generic
`@revisium/revo-agent-runtime` root API. Definitions are discovered and pinned
during admission; the active invocation registry remains the sole durable state
sink. It is therefore impossible for the public manager, including an installed
package consumer, to inject an agent fake or choose a runtime mode.

## Consequences

- Test fakes remain under `test/support/agent-runtime/` and are never imported
  by production source, exported from the root, or packed.
- Tests can exercise the durable host's stable invocation identity, lookup and
  cancellation paths without exposing the runtime manager as a public option.
- The adapter must not change the public manager model or move pipeline
  control-flow into `revo-run`.
