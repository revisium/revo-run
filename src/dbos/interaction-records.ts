import type { ValueSchema } from '@revisium/revo-pipeline';

export const gateConfigurationKey = (gateId: string): string => `revo-run.gate-config:${gateId}`;
export const signalWaitConfigurationKey = (waitId: string): string =>
  `revo-run.signal-wait-config:${waitId}`;
export const runEventHighWaterKey = 'revo-run.events-high-water';

export interface GateConfigurationV1 {
  readonly schemaVersion: 'run-gate-configuration/v1';
  readonly operationId: string;
  readonly authorizationRequirements: readonly string[];
  readonly payloadSchema: ValueSchema | null;
}

export interface SignalWaitConfigurationV1 {
  readonly schemaVersion: 'run-signal-wait-configuration/v1';
  readonly operationId: string;
  readonly payloadSchema: ValueSchema | null;
}
