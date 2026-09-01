import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { StartAgentInvocation as RuntimeStartInput } from '@revisium/revo-agent-runtime';

import type { AgentRuntimeStartInput } from '../../agent-port.js';
import { runtimeResultSchema } from './result-mapper.js';

const outputDirectory = (workspace: string, invocationId: string): string =>
  join(workspace, `.revo-agent-output-${createHash('sha256').update(invocationId).digest('hex')}`);

export const runtimeRequest = (
  input: AgentRuntimeStartInput,
  workspace: string,
): RuntimeStartInput => ({
  invocationId: input.invocationId,
  agent: {
    id: input.binding.pin.agentId,
    version: input.binding.pin.agentVersion,
  },
  prompt: input.prompt,
  workspace: { directory: workspace },
  parameters: input.binding.parameters,
  permissions: input.binding.permissions,
  ...(input.binding.configuration === undefined
    ? {}
    : { configuration: input.binding.configuration }),
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  result: { schema: runtimeResultSchema(input.result.schema) },
  output: { directory: outputDirectory(workspace, input.invocationId) },
  ...(input.limits === undefined ? {} : { limits: input.limits }),
});
