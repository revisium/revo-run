import type { PipelineSourcePackage } from '@revisium/revo-pipeline';
import { createRevoScripts } from '@revisium/revo-scripts';
import { describe, expect, it, vi } from 'vitest';

import { admitRun } from '../../src/admission/admit-run.js';
import { unavailableAgentPort } from '../../src/composition/agent-port.js';
import { RunHostReadinessFence } from '../../src/composition/readiness-fence.js';
import type { RunComposition } from '../../src/composition/run-composition.js';
import type { CreateRunInput } from '../../src/contracts/manager.js';
import { RunManagerError } from '../../src/contracts/run-manager-error.js';
import type { AgentAssignment } from '../../src/contracts/run-profile.js';

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const agentInputSchema = {
  type: 'object' as const,
  properties: { prompt: { type: 'string' as const, enum: ['Review'] } },
  required: ['prompt'],
  additionalProperties: false as const,
};

const agentPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-agent-admission',
  entryModule: 'main',
  maximumTotalActivities: 1,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'review',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'agent',
            id: 'review',
            strategies: [
              {
                kind: 'single',
                routes: { succeeded: 'done', failed: 'done', cancelled: 'done' },
              },
            ],
            input: { prompt: { kind: 'literal', value: 'Review' } },
            inputSchema: agentInputSchema,
            outputSchema: emptySchema,
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const reviewerAssignment: AgentAssignment = {
  definition: { id: 'reviewer', version: '1' },
  parameters: {},
  permissions: {},
  workspaceRef: 'workspace-1',
};

const baseInput = (
  agents: Readonly<Record<string, AgentAssignment>> = { 'reviewer-binding': reviewerAssignment },
): CreateRunInput => ({
  runId: 'rn1-agent-admission',
  pipeline: agentPipeline,
  profile: {
    schemaVersion: 'run-profile/v1',
    selections: {
      review: {
        strategy: 'single',
        participant: { key: 'reviewer', bindingKey: 'reviewer-binding' },
      },
    },
    bindings: {
      agents,
      scripts: {},
    },
  },
  input: {},
});

const consensusInput = (): CreateRunInput => {
  const source = structuredClone(agentPipeline);
  const module = source.modules[0];
  if (module === undefined) {
    throw new Error('Expected the agent admission fixture.');
  }
  const participants = [
    { key: 'reviewer-one', bindingKey: 'reviewer-one-binding' },
    { key: 'reviewer-two', bindingKey: 'reviewer-two-binding' },
    { key: 'reviewer-three', bindingKey: 'reviewer-three-binding' },
  ] as const;
  return {
    ...baseInput(
      Object.fromEntries(
        participants.map(({ bindingKey }, index) => [
          bindingKey,
          { ...reviewerAssignment, definition: { id: `reviewer-${index + 1}`, version: '1' } },
        ]),
      ),
    ),
    runId: 'rn1-agent-consensus-admission',
    pipeline: {
      ...source,
      key: 'rn1-agent-consensus-admission',
      maximumTotalActivities: 3,
      modules: [
        {
          ...module,
          region: {
            ...module.region,
            entry: 'review-consensus',
            nodes: [
              {
                kind: 'consensus',
                id: 'review-consensus',
                participants: [
                  {
                    key: participants[0].key,
                    bindingKey: participants[0].bindingKey,
                    input: { prompt: { kind: 'literal', value: 'Review' } },
                    inputSchema: agentInputSchema,
                  },
                  {
                    key: participants[1].key,
                    bindingKey: participants[1].bindingKey,
                    input: { prompt: { kind: 'literal', value: 'Review' } },
                    inputSchema: agentInputSchema,
                  },
                  {
                    key: participants[2].key,
                    bindingKey: participants[2].bindingKey,
                    input: { prompt: { kind: 'literal', value: 'Review' } },
                    inputSchema: agentInputSchema,
                  },
                ],
                policy: { kind: 'unanimous' },
                remaining: 'drain',
                routes: {
                  approved: 'done',
                  rejected: 'done',
                  inconclusive: 'done',
                  participantFailed: 'done',
                  cancelled: 'done',
                },
              },
              ...module.region.nodes.slice(1),
            ],
          },
        },
      ],
    },
    profile: {
      schemaVersion: 'run-profile/v1',
      selections: {},
      bindings: {
        agents: Object.fromEntries(
          participants.map(({ bindingKey }, index) => [
            bindingKey,
            { ...reviewerAssignment, definition: { id: `reviewer-${index + 1}`, version: '1' } },
          ]),
        ),
        scripts: {},
      },
    },
    input: {},
  };
};

const composition = (): Readonly<{
  readonly value: RunComposition;
  readonly initializeAgents: ReturnType<typeof vi.fn>;
  readonly prepareBinding: ReturnType<typeof vi.spyOn>;
}> => {
  const scripts = createRevoScripts({
    host: {
      resources: { inspect: async () => undefined },
      workspaces: {
        inspect: async () => undefined,
        acquire: async () => {
          throw new Error('Unexpected workspace acquisition.');
        },
      },
      credentials: {
        inspect: async () => undefined,
        acquire: async () => {
          throw new Error('Unexpected credential acquisition.');
        },
      },
    },
  });
  const initializeAgents = vi.fn<() => Promise<void>>(async () => undefined);
  return {
    value: {
      fence: new RunHostReadinessFence(),
      agents: { ...unavailableAgentPort, initialize: initializeAgents },
      scripts,
    },
    initializeAgents,
    prepareBinding: vi.spyOn(scripts, 'prepareBinding'),
  };
};

const expectCode = async (
  promise: Promise<unknown>,
  code: RunManagerError['code'],
): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code });
};

const admitUnknown = (input: unknown, value: RunComposition): Promise<unknown> => {
  const result: unknown = Reflect.apply(admitRun, undefined, [input, value]);
  return Promise.resolve(result);
};

describe('RN1 admission profile boundary', () => {
  it('reports a malformed run ID before the rest of the create-run envelope', async () => {
    const composed = composition();

    await expectCode(
      admitRun({ ...baseInput(), runId: 'not a run id' }, composed.value),
      'invalid_run_id',
    );

    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('keeps invalid run-ID precedence when the rest of the envelope is malformed', async () => {
    const composed = composition();
    const malformed = {
      ...baseInput(),
      runId: 'not a run id',
      profile: null,
    };

    await expectCode(admitUnknown(malformed, composed.value), 'invalid_run_id');

    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('validates the entry input before profile resolution, agent availability, or script binding', async () => {
    const composed = composition();

    await expectCode(
      admitRun({ ...baseInput(), input: { unexpected: true } }, composed.value),
      'invalid_create_run_input',
    );

    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('rejects a valid agent-bearing profile fail-closed before script preparation', async () => {
    const composed = composition();

    await expectCode(admitRun(baseInput(), composed.value), 'agent_runtime_unavailable');

    expect(composed.initializeAgents).not.toHaveBeenCalled();
    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('validates all three consensus assignments before the private unavailable agent port rejects execution', async () => {
    const composed = composition();

    await expectCode(admitRun(consensusInput(), composed.value), 'agent_runtime_unavailable');

    expect(composed.initializeAgents).not.toHaveBeenCalled();
    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('requires every agent binding before it evaluates the unavailable agent boundary', async () => {
    const composed = composition();

    await expectCode(admitRun(baseInput({}), composed.value), 'run_requirement_unresolved');

    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('rejects extra portable agent bindings before script preparation', async () => {
    const agents = {
      'reviewer-binding': reviewerAssignment,
      unused: {
        definition: { id: 'unused', version: '1' },
        parameters: {},
        permissions: {},
        workspaceRef: 'workspace-1',
      },
    };
    const composed = composition();

    await expectCode(admitRun(baseInput(agents), composed.value), 'run_profile_invalid');

    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });
});
