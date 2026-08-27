import { createRunManager, type PipelineSourcePackage, type RunProfile } from '@revisium/revo-run';

declare const pipeline: PipelineSourcePackage;
declare const profile: RunProfile;

const manager = createRunManager({
  database: { url: 'postgresql://example.invalid/revo-run' },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('The root-only consumer does not execute a host call.');
      },
    },
    credentials: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('The root-only consumer does not execute a host call.');
      },
    },
  },
});

void manager.createRun({ runId: 'raw-consumer-run', pipeline, profile, input: {} });
