import type { PipelineCommand, PipelineEvent } from '@revisium/revo-pipeline/kernel';
import type { ScriptTerminalAttemptResult } from '@revisium/revo-scripts';
import { describe, expect, it } from 'vitest';

import type { AgentInvocationResult } from '../../src/composition/agent-port.js';
import {
  deriveAgentTerminalPipelineEvent,
  deriveScriptTerminalPipelineEvent,
  requireExactPipelineEvent,
} from '../../src/dbos/kernel-run-workflow.js';

const digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000001';
const command = {
  kind: 'dispatchActivity',
  key: digest,
  ref: { programDigest: digest, frameKey: digest, nodeId: digest },
  requirementKey: 'script',
  input: {},
  outputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
} as const satisfies Extract<PipelineCommand, { readonly kind: 'dispatchActivity' }>;

const lifecycle = {
  script: { id: 'script:test/relay', version: 1 },
  definitionDigest: digest,
  attemptOrdinal: 1,
  timestampMs: 1,
} as const;

const scriptResults: readonly ScriptTerminalAttemptResult[] = [
  {
    kind: 'succeeded',
    value: { decision: 'approved' },
    evidence: [],
    terminalEvent: {
      emissionOrdinal: 2,
      event: { name: 'revo.script.succeeded', details: { ...lifecycle, evidenceCount: 0 } },
    },
  },
  {
    kind: 'failed',
    error: {
      code: 'revo.script.execution.handler_failed',
      message: 'failed',
      retryable: false,
      stage: 'handler',
      details: null,
      causes: [],
    },
    evidence: [],
    terminalEvent: {
      emissionOrdinal: 2,
      event: {
        name: 'revo.script.failed',
        details: {
          ...lifecycle,
          code: 'revo.script.execution.handler_failed',
          stage: 'handler',
          retryable: false,
        },
      },
    },
  },
  {
    kind: 'cancelled',
    evidence: [],
    terminalEvent: {
      emissionOrdinal: 2,
      event: { name: 'revo.script.cancelled', details: lifecycle },
    },
  },
  {
    kind: 'timedOut',
    error: {
      code: 'revo.script.execution.timeout',
      message: 'timed out',
      retryable: false,
      stage: 'handler',
      details: null,
      causes: [],
    },
    evidence: [],
    terminalEvent: {
      emissionOrdinal: 2,
      event: {
        name: 'revo.script.timed_out',
        details: { ...lifecycle, code: 'revo.script.execution.timeout' },
      },
    },
  },
];

const agentBase = {
  schemaVersion: 'agent-invocation-result/v1' as const,
  invocationId: 'att_relay',
  pin: { agentId: 'agent', agentVersion: '1.0.0', definitionDigest: digest },
  launch: { executable: 'private-agent', reportedVersion: '1.0.0' },
  acceptedAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 0,
  exit: { code: 0, signal: null },
  files: {
    directory: 'private-agent',
    events: 'events.ndjson' as const,
    stdout: 'stdout.log' as const,
    stderr: 'stderr.log' as const,
    result: 'result.json' as const,
  },
};

const agentResults: readonly AgentInvocationResult[] = [
  { ...agentBase, status: 'succeeded', value: { decision: 'approved' } },
  {
    ...agentBase,
    status: 'cancelled',
    error: {
      code: 'revo.agent.cancelled',
      message: 'cancelled',
      phase: 'running',
      retryable: false,
    },
  },
  {
    ...agentBase,
    status: 'failed',
    error: {
      code: 'revo.agent.process_failed',
      message: 'failed',
      phase: 'running',
      retryable: false,
    },
  },
];

const hostileEvent = (expected: PipelineEvent): PipelineEvent =>
  expected.kind === 'activityCancelled'
    ? {
        kind: 'activityFailed',
        commandKey: command.key,
        ref: command.ref,
        errorCode: 'hostile',
      }
    : { kind: 'activityCancelled', commandKey: command.key, ref: command.ref };

describe('RN1 operation observation relay/result binding', () => {
  it.each(scriptResults.map((result) => [result.kind, result] as const))(
    'rejects a valid-but-mismatched %s script terminal relay before journal mutation',
    (_kind, result) => {
      const expected = deriveScriptTerminalPipelineEvent(command, result);
      expect(() => requireExactPipelineEvent(hostileEvent(expected), expected)).toThrow(
        'Operation observation event does not match its owning terminal result.',
      );
    },
  );

  it.each(agentResults.map((result) => [result.status, result] as const))(
    'rejects a valid-but-mismatched %s agent terminal relay before journal mutation',
    (_status, result) => {
      const expected = deriveAgentTerminalPipelineEvent(command, result);
      expect(() => requireExactPipelineEvent(hostileEvent(expected), expected)).toThrow(
        'Operation observation event does not match its owning terminal result.',
      );
    },
  );
});
