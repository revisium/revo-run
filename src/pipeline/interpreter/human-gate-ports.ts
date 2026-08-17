import type { HumanGateNode } from '../../contracts/pipeline/pipeline-node.js';

export interface HumanGateWaitRequest {
  readonly gateInstanceId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly answers: readonly string[];
  readonly decision: HumanGateNode['decision'];
  readonly eligibleGroup?: string;
  readonly timeoutMs?: number;
}

export type HumanGateResolution =
  | { readonly kind: 'answered'; readonly answer: string; readonly commandIds: readonly string[] }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'fail' };

export type WaitForHumanGate = (request: HumanGateWaitRequest) => Promise<HumanGateResolution>;
