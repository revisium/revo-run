import { join } from 'node:path';

import type { StartAgentInvocation as RuntimeStartInput } from '@revisium/revo-agent-runtime';

import type { AgentRuntimeStartInput } from '../../agent-port.js';
import { runtimeResultSchema } from './result-mapper.js';

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
  output: { directory: join(workspace, '.revo-agent-output', input.invocationId) },
  ...(input.limits === undefined ? {} : { limits: input.limits }),
});
