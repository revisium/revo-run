import type { IntentTrace } from './intent-trace.js';

export const executionIntentTrace = [
  {
    intentId: 'rr-001',
    category: 'agentExecution',
    name: 'executes an agent and passes its output to a script',
  },
  {
    intentId: 'rr-002',
    category: 'agentExecution',
    name: 'routes a permanent agent failure explicitly',
  },
  {
    intentId: 'rr-003',
    category: 'agentExecution',
    name: 'times out a bounded agent execution and routes the timeout',
  },
  {
    intentId: 'rr-004',
    category: 'scriptExecution',
    name: 'executes an immutable versioned script binding',
  },
  {
    intentId: 'rr-005',
    category: 'scriptExecution',
    name: 'routes a permanent script failure without retrying it',
  },
  { intentId: 'rr-006', category: 'scriptExecution', name: 'times out a bounded script execution' },
  {
    intentId: 'rr-007',
    category: 'retry',
    name: 'retries a transient agent failure with durable backoff',
  },
  {
    intentId: 'rr-008',
    category: 'retry',
    name: 'stops retrying a script after the configured attempt limit',
  },
  {
    intentId: 'rr-009',
    category: 'retry',
    name: 'does not retry an error code outside the retry allowlist',
  },
  {
    intentId: 'rr-010',
    category: 'retry',
    name: 'resumes durable retry backoff after a manager restart',
  },
  {
    intentId: 'rr-011',
    category: 'recovery',
    name: 'adopts a reconciled external effect after a crash before its checkpoint',
  },
  {
    intentId: 'rr-012',
    category: 'recovery',
    name: 'requires attributed human resolution when reconciliation returns unknown',
  },
  {
    intentId: 'rr-013',
    category: 'recovery',
    name: 'fails deterministically when an unknown effect is configured to fail',
  },
  {
    intentId: 'rr-014',
    category: 'recovery',
    name: 'executes an effect once after restarting before the effect begins',
  },
  {
    intentId: 'rr-015',
    category: 'recovery',
    name: 'fails after exhausting bounded reconciliation attempts',
  },
  {
    intentId: 'rr-016',
    category: 'recovery',
    name: 'retries safely after reconciliation proves the external effect is absent',
  },
  {
    intentId: 'rr-017',
    category: 'cancellation',
    name: 'cancels an active agent execution cooperatively',
  },
  {
    intentId: 'rr-018',
    category: 'cancellation',
    name: 'cancels a run while it is waiting for retry backoff',
  },
  {
    intentId: 'rr-019',
    category: 'cancellation',
    name: 'treats repeated cancellation commands as idempotent',
  },
  {
    intentId: 'rr-020',
    category: 'cancellation',
    name: 'keeps a completed run terminal after a later cancellation request',
  },
  {
    intentId: 'rr-021',
    category: 'validation',
    name: 'fails an unhandled custom task outcome instead of treating it as success',
  },
  { intentId: 'rr-022', category: 'validation', name: 'does not select inherited outcome routes' },
] as const satisfies readonly IntentTrace[];
