import { digestCanonicalJson } from '../../policy/index.js';

export const deriveChildWorkflowId = (
  runId: string,
  kind: 'candidate' | 'task',
  nodeKey: string,
  candidate?: string,
): string => {
  const tuple = [runId, kind, nodeKey, candidate ?? ''].map(
    (component) => `${component.length}:${component}`,
  );
  return `revo-${kind}-${digestCanonicalJson(tuple).slice('sha256:'.length)}`;
};
