import type { IntentTrace } from './intent-trace.js';

export const coordinationIntentTrace = [
  {
    intentId: 'rr-023',
    category: 'dataFlow',
    name: 'selects a branch from a completed node output',
  },
  {
    intentId: 'rr-024',
    category: 'dataFlow',
    name: 'uses an explicit default branch for an uncovered value',
  },
  {
    intentId: 'rr-025',
    category: 'parallelExecution',
    name: 'waits for every successful branch at an all join',
  },
  {
    intentId: 'rr-026',
    category: 'parallelExecution',
    name: 'runs a multi-step pipeline as one parallel branch',
  },
  {
    intentId: 'rr-027',
    category: 'parallelExecution',
    name: 'fails an all join when one branch fails and drains the remainder',
  },
  {
    intentId: 'rr-028',
    category: 'parallelExecution',
    name: 'drains remaining branches after an any join succeeds',
  },
  {
    intentId: 'rr-029',
    category: 'parallelExecution',
    name: 'fails an any join after every branch fails',
  },
  {
    intentId: 'rr-030',
    category: 'parallelExecution',
    name: 'drains every branch before completing a threshold join',
  },
  {
    intentId: 'rr-031',
    category: 'dataFlow',
    name: 'publishes a branch input failure through the run event stream',
  },
  {
    intentId: 'rr-032',
    category: 'dataFlow',
    name: 'makes parallel branch outputs available after the join',
  },
  {
    intentId: 'rr-033',
    category: 'parallelExecution',
    name: 'applies the run parallelism limit across nested parallel branches',
  },
  {
    intentId: 'rr-034',
    category: 'parallelExecution',
    name: 'cancels remaining branches after a threshold join succeeds',
  },
  {
    intentId: 'rr-035',
    category: 'parallelExecution',
    name: 'fails a threshold join when the threshold becomes unreachable',
  },
  {
    intentId: 'rr-036',
    category: 'consensus',
    name: 'approves a unanimous consensus after every participant approves',
  },
  {
    intentId: 'rr-037',
    category: 'consensus',
    name: 'rejects a unanimous consensus as soon as one participant rejects',
  },
  {
    intentId: 'rr-038',
    category: 'consensus',
    name: 'reports an insufficient quorum when too many participants abstain',
  },
  {
    intentId: 'rr-039',
    category: 'consensus',
    name: 'applies independent approve and reject thresholds',
  },
  {
    intentId: 'rr-040',
    category: 'consensus',
    name: 'rejects duplicate and unknown participant votes',
  },
  {
    intentId: 'rr-041',
    category: 'consensus',
    name: 'fails consensus when a participant execution fails',
  },
  {
    intentId: 'rr-042',
    category: 'consensus',
    name: 'routes consensus timeout without waiting forever',
  },
  {
    intentId: 'rr-043',
    category: 'humanGate',
    name: 'continues after answering a human gate following a manager restart',
  },
  {
    intentId: 'rr-044',
    category: 'humanGate',
    name: 'accepts an idempotent gate command once and rejects a conflicting command',
  },
  {
    intentId: 'rr-045',
    category: 'humanGate',
    name: 'requires distinct authorized approvers for separation of duties',
  },
  { intentId: 'rr-046', category: 'humanGate', name: 'rejects an answer from an ineligible actor' },
  {
    intentId: 'rr-047',
    category: 'humanGate',
    name: 'routes conflicting multi-approver answers by an explicit gate policy',
  },
  {
    intentId: 'rr-048',
    category: 'humanGate',
    name: 'rejects an answer outside the gate answer vocabulary',
  },
  {
    intentId: 'rr-049',
    category: 'humanGate',
    name: 'routes an unanswered human gate after its deadline',
  },
  {
    intentId: 'rr-050',
    category: 'humanGate',
    name: 'cancels a run while it is waiting at a human gate',
  },
  {
    intentId: 'rr-051',
    category: 'subpipeline',
    name: 'passes immutable input into a subpipeline and returns its output',
  },
  {
    intentId: 'rr-052',
    category: 'subpipeline',
    name: 'routes a failed subpipeline outcome in its parent',
  },
  {
    intentId: 'rr-053',
    category: 'subpipeline',
    name: 'rejects a plan that references a missing subpipeline',
  },
  {
    intentId: 'rr-054',
    category: 'repeat',
    name: 'passes the previous iteration output into the next review iteration',
  },
  {
    intentId: 'rr-055',
    category: 'repeat',
    name: 'supports a bounded repeat nested inside another repeat',
  },
  {
    intentId: 'rr-056',
    category: 'repeat',
    name: 'routes an exhausted repeat after reaching its iteration limit',
  },
  {
    intentId: 'rr-057',
    category: 'repeat',
    name: 'rejects an unbounded repeat during plan validation',
  },
] as const satisfies readonly IntentTrace[];
