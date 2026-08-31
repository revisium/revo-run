import { createRevoScripts, type RevoScripts } from '@revisium/revo-scripts';

import type { CreateRunManagerOptions } from '../contracts/manager.js';
import { agentActiveInvocationStateSink } from '../dbos/agent-active-invocation-registry.js';
import type { AgentRuntimePort } from './agent-port.js';
import { createCodexAgentRuntimePort } from './agents/codex/codex-agent-runtime-port.js';
import { RunHostReadinessFence } from './readiness-fence.js';

export interface RunComposition {
  readonly fence: RunHostReadinessFence;
  readonly agents: AgentRuntimePort;
  readonly scripts: RevoScripts;
}

let activeComposition: RunComposition | undefined;

export const createRunComposition = (options: CreateRunManagerOptions): RunComposition =>
  Object.freeze({
    fence: new RunHostReadinessFence(),
    agents: createCodexAgentRuntimePort(options.host.workspaces, agentActiveInvocationStateSink),
    scripts: createRevoScripts({ host: options.host }),
  });

export const installRunComposition = (composition: RunComposition): void => {
  if (activeComposition !== undefined && activeComposition !== composition) {
    throw new Error('A run composition is already installed.');
  }
  activeComposition = composition;
};

export const clearRunComposition = (composition: RunComposition): void => {
  if (activeComposition === composition) {
    activeComposition = undefined;
  }
};

export const requireRunComposition = (): RunComposition => {
  if (activeComposition === undefined) {
    throw new Error('Run host composition is unavailable.');
  }
  return activeComposition;
};
