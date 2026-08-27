import { isJsonObject } from '../contracts/json.js';
import { isUtcTimestamp } from '../contracts/public-schemas.js';
import type { AgentInvocationResult } from './agent-port.js';

const agentFaultCodes = new Set<string>([
  'revo.agent.definition_invalid',
  'revo.agent.definition_duplicate',
  'revo.agent.strategy_unsupported',
  'revo.agent.limit_invalid',
  'revo.agent.agent_unknown',
  'revo.agent.invocation_invalid',
  'revo.agent.invocation_duplicate',
  'revo.agent.invocation_unknown',
  'revo.agent.workspace_invalid',
  'revo.agent.parameters_invalid',
  'revo.agent.permissions_invalid',
  'revo.agent.result_schema_invalid',
  'revo.agent.environment_invalid',
  'revo.agent.output_path_invalid',
  'revo.agent.output_conflict',
  'revo.agent.scratch_failed',
  'revo.agent.spawn_failed',
  'revo.agent.authentication_failed',
  'revo.agent.permission_denied',
  'revo.agent.manager_not_initialized',
  'revo.agent.manager_closed',
  'revo.agent.shutdown_failed',
  'revo.agent.recovery_invalid',
  'revo.agent.recovery_failed',
  'revo.agent.platform_unsupported',
  'revo.agent.probe_platform_unsupported',
  'revo.agent.probe_spawn_failed',
  'revo.agent.probe_timeout',
  'revo.agent.probe_output_too_large',
  'revo.agent.probe_process_failed',
  'revo.agent.probe_output_invalid',
  'revo.agent.probe_version_mismatch',
  'revo.agent.protocol_failed',
  'revo.agent.output_write_failed',
  'revo.agent.active_state_failed',
  'revo.agent.process_identity_failed',
  'revo.agent.process_failed',
  'revo.agent.process_cleanup_failed',
  'revo.agent.result_missing',
  'revo.agent.result_too_large',
  'revo.agent.result_invalid_json',
  'revo.agent.result_not_object',
  'revo.agent.result_schema_mismatch',
  'revo.agent.scratch_cleanup_failed',
  'revo.agent.cancelled',
  'revo.agent.timeout',
  'revo.agent.internal',
]);

const agentFaultPhases = new Set<string>([
  'construction',
  'initializing',
  'manager',
  'shutdown',
  'probing',
  'preflight',
  'starting',
  'running',
  'collecting_result',
  'finalizing',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const isBoundedString = (value: unknown, maximum = 4_096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPin = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ['agentId', 'agentVersion', 'definitionDigest']) &&
  isBoundedString(value.agentId, 256) &&
  isBoundedString(value.agentVersion, 256) &&
  isBoundedString(value.definitionDigest, 256);

const isFiles = (value: unknown, resultRequired: boolean): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  const allowed = ['directory', 'events', 'stdout', 'stderr', 'result', 'rawFinalResponse'];
  if (!hasOnlyKeys(value, allowed) || !isBoundedString(value.directory, 4_096)) {
    return false;
  }
  return (
    value.events === 'events.ndjson' &&
    value.stdout === 'stdout.log' &&
    value.stderr === 'stderr.log' &&
    (value.result === undefined || value.result === 'result.json') &&
    (!resultRequired || value.result === 'result.json') &&
    (value.rawFinalResponse === undefined || value.rawFinalResponse === 'raw-final-response.txt')
  );
};

const isUsage = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  const tokenKeys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  const allowed = [...tokenKeys, 'reportedCost', 'reportedCurrency'];
  return (
    hasOnlyKeys(value, allowed) &&
    tokenKeys.every((key) => value[key] === undefined || isSafeNonNegativeInteger(value[key])) &&
    (value.reportedCost === undefined ||
      (typeof value.reportedCost === 'number' &&
        Number.isFinite(value.reportedCost) &&
        value.reportedCost >= 0)) &&
    (value.reportedCurrency === undefined || isBoundedString(value.reportedCurrency, 16))
  );
};

const isFault = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ['code', 'message', 'phase', 'retryable', 'details']) &&
  typeof value.code === 'string' &&
  agentFaultCodes.has(value.code) &&
  isBoundedString(value.message) &&
  typeof value.phase === 'string' &&
  agentFaultPhases.has(value.phase) &&
  typeof value.retryable === 'boolean' &&
  (value.details === undefined || isJsonObject(value.details));

const isRawResponseDiagnostic = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ['preview', 'truncated', 'file']) &&
  typeof value.preview === 'string' &&
  value.preview.length <= 4_096 &&
  typeof value.truncated === 'boolean' &&
  (value.file === undefined || value.file === 'raw-final-response.txt');

const isBaseResult = (value: Record<string, unknown>): boolean =>
  value.schemaVersion === 'agent-invocation-result/v1' &&
  isBoundedString(value.invocationId, 256) &&
  isPin(value.pin) &&
  isRecord(value.launch) &&
  hasExactKeys(value.launch, ['executable', 'reportedVersion']) &&
  isBoundedString(value.launch.executable, 4_096) &&
  isBoundedString(value.launch.reportedVersion, 256) &&
  (value.metadata === undefined || isJsonObject(value.metadata)) &&
  isUtcTimestamp(value.acceptedAt) &&
  (value.startedAt === undefined || isUtcTimestamp(value.startedAt)) &&
  isUtcTimestamp(value.finishedAt) &&
  isSafeNonNegativeInteger(value.durationMs) &&
  isRecord(value.exit) &&
  hasExactKeys(value.exit, ['code', 'signal']) &&
  (value.exit.code === null || Number.isSafeInteger(value.exit.code)) &&
  (value.exit.signal === null || isBoundedString(value.exit.signal, 256)) &&
  (value.usage === undefined || isUsage(value.usage));

/** Validates the private agent-result carrier before it enters durable workflow history. */
export const isAgentInvocationResult = (value: unknown): value is AgentInvocationResult => {
  if (!isRecord(value) || !isBaseResult(value)) {
    return false;
  }
  const baseKeys = [
    'schemaVersion',
    'invocationId',
    'pin',
    'launch',
    'metadata',
    'acceptedAt',
    'startedAt',
    'finishedAt',
    'durationMs',
    'exit',
    'usage',
    'files',
    'status',
  ];
  if (value.status === 'succeeded') {
    return (
      hasOnlyKeys(value, [...baseKeys, 'value']) &&
      isFiles(value.files, true) &&
      isJsonObject(value.value)
    );
  }
  if (value.status === 'failed') {
    return (
      hasOnlyKeys(value, [...baseKeys, 'error', 'rawResponse']) &&
      isFiles(value.files, false) &&
      isFault(value.error) &&
      (value.rawResponse === undefined || isRawResponseDiagnostic(value.rawResponse))
    );
  }
  return (
    (value.status === 'cancelled' || value.status === 'timed_out') &&
    hasOnlyKeys(value, [...baseKeys, 'error']) &&
    isFiles(value.files, true) &&
    isFault(value.error)
  );
};
