import type { IntentTrace } from './intent-trace.js';

export const enterpriseIntentTrace = [
  {
    intentId: 'rr-058',
    category: 'dataFlow',
    name: 'passes a versioned entity reference without embedding entity data in the plan',
  },
  {
    intentId: 'rr-059',
    category: 'dataFlow',
    name: 'passes a durable artifact reference between node executions',
  },
  {
    intentId: 'rr-060',
    category: 'dataFlow',
    name: 'resolves a secret only at the executor boundary and never persists its value',
  },
  { intentId: 'rr-061', category: 'dataFlow', name: 'keeps reference-shaped executor JSON inert' },
  {
    intentId: 'rr-062',
    category: 'dataFlow',
    name: 'fails a task safely when a referenced secret cannot be resolved',
  },
  {
    intentId: 'rr-063',
    category: 'dataFlow',
    name: 'fails deterministically when a pinned entity version is unavailable',
  },
  {
    intentId: 'rr-064',
    category: 'dataFlow',
    name: 'stores a large node result as an artifact reference',
  },
  {
    intentId: 'rr-065',
    category: 'dataFlow',
    name: 'uses an explicitly pinned artifact as task input',
  },
  {
    intentId: 'rr-066',
    category: 'dataFlow',
    name: 'fails deterministically when a referenced output key is missing',
  },
  {
    intentId: 'rr-067',
    category: 'dataFlow',
    name: 'fails deterministically when a referenced JSON pointer is missing',
  },
  {
    intentId: 'rr-068',
    category: 'map',
    name: 'maps a bounded task over dynamically supplied entities',
  },
  {
    intentId: 'rr-069',
    category: 'map',
    name: 'completes an empty map without scheduling child executions',
  },
  {
    intentId: 'rr-070',
    category: 'map',
    name: 'encodes data-controlled map item keys in runtime paths',
  },
  {
    intentId: 'rr-071',
    category: 'map',
    name: 'rejects map input that exceeds its declared item bound',
  },
  {
    intentId: 'rr-072',
    category: 'map',
    name: 'cancels remaining map items after one item fails in fail-fast mode',
  },
  {
    intentId: 'rr-073',
    category: 'map',
    name: 'enforces map-local concurrency independently of item count',
  },
  {
    intentId: 'rr-074',
    category: 'map',
    name: 'collects failed map items and exposes a deterministic aggregate outcome',
  },
  {
    intentId: 'rr-075',
    category: 'delay',
    name: 'survives a manager restart while waiting for a durable delay',
  },
  {
    intentId: 'rr-076',
    category: 'delay',
    name: 'cancels a durable delay without waiting for its deadline',
  },
  {
    intentId: 'rr-077',
    category: 'cancellation',
    name: 'cancels every active parallel child without leaving detached work',
  },
  {
    intentId: 'rr-078',
    category: 'recovery',
    name: 'recovers parallel executions without duplicate effects',
  },
  {
    intentId: 'rr-079',
    category: 'concurrency',
    name: 'enforces the plan-wide active execution limit across parallel nodes',
  },
  {
    intentId: 'rr-080',
    category: 'subscription',
    name: 'resumes a run subscription from its last durable cursor',
  },
  {
    intentId: 'rr-081',
    category: 'subscription',
    name: 'publishes a durable terminal failure event',
  },
  {
    intentId: 'rr-082',
    category: 'subscription',
    name: 'rejects a subscription cursor that does not belong to the run',
  },
  {
    intentId: 'rr-083',
    category: 'subscription',
    name: 'exposes every nested execution through current run details',
  },
  {
    intentId: 'rr-084',
    category: 'subscription',
    name: 'resumes a durable subscription cursor after a manager restart',
  },
  {
    intentId: 'rr-085',
    category: 'validation',
    name: 'rejects an unsupported execution plan schema version',
  },
  {
    intentId: 'rr-086',
    category: 'validation',
    name: 'rejects an execution plan whose root pipeline is missing',
  },
  {
    intentId: 'rr-087',
    category: 'validation',
    name: 'rejects a task without exactly one executor binding',
  },
  {
    intentId: 'rr-088',
    category: 'validation',
    name: 'rejects duplicate executor bindings for one task',
  },
  {
    intentId: 'rr-089',
    category: 'validation',
    name: 'rejects a plan whose repeat bound exceeds the total execution bound',
  },
  {
    intentId: 'rr-090',
    category: 'validation',
    name: 'rejects a branch without a required default route',
  },
  {
    intentId: 'rr-091',
    category: 'validation',
    name: 'rejects an executor binding that targets a missing node path',
  },
  {
    intentId: 'rr-092',
    category: 'validation',
    name: 'rejects an executor binding that targets a control node',
  },
  { intentId: 'rr-093', category: 'validation', name: 'rejects duplicate sibling node keys' },
  {
    intentId: 'rr-094',
    category: 'validation',
    name: 'rejects duplicate addressable keys across parallel branches',
  },
  { intentId: 'rr-095', category: 'validation', name: 'rejects reserved characters in a node key' },
  {
    intentId: 'rr-096',
    category: 'validation',
    name: 'rejects reserved characters in the root pipeline id',
  },
  { intentId: 'rr-097', category: 'validation', name: 'rejects duplicate runtime map item keys' },
  {
    intentId: 'rr-098',
    category: 'validation',
    name: 'rejects an unreachable consensus threshold',
  },
  {
    intentId: 'rr-099',
    category: 'validation',
    name: 'rejects a composed map and repeat bound above the total execution limit',
  },
  {
    intentId: 'rr-100',
    category: 'validation',
    name: 'rejects structural nodes beyond the configured nesting bound',
  },
  {
    intentId: 'rr-101',
    category: 'validation',
    name: 'rejects subpipeline composition beyond the configured depth bound',
  },
  { intentId: 'rr-102', category: 'validation', name: 'rejects direct subpipeline recursion' },
  { intentId: 'rr-103', category: 'validation', name: 'rejects indirect subpipeline recursion' },
] as const satisfies readonly IntentTrace[];
