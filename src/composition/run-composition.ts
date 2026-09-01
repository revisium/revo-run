import { createRevoScripts, type RevoScripts } from '@revisium/revo-scripts';

import type { CreateRunManagerOptions } from '../contracts/manager.js';
import type { AgentRuntimePort } from './agent-port.js';
import { createRevoAgentRuntimePort } from './agents/revo-runtime/revo-agent-runtime-port.js';
import { RunHostReadinessFence } from './readiness-fence.js';

export interface RunComposition {
  readonly fence: RunHostReadinessFence;
  readonly agents: AgentRuntimePort;
  readonly scripts: RevoScripts;
}

let activeComposition: RunComposition | undefined;

export const createRunComposition = async (
  options: CreateRunManagerOptions,
): Promise<RunComposition> =>
  Object.freeze({
    fence: new RunHostReadinessFence(),
    agents: await createRevoAgentRuntimePort(options),
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
