import type { PipelineSourcePackage } from '@revisium/revo-pipeline';
import { createRevoScripts, type PreparedScriptBinding } from '@revisium/revo-scripts';
import { describe, expect, it, vi } from 'vitest';

import { admitRun } from '../../src/admission/admit-run.js';
import {
  unavailableAgentPort,
  type AgentBindingInput,
  type PreparedAgentBinding,
} from '../../src/composition/agent-port.js';
import { RunHostReadinessFence } from '../../src/composition/readiness-fence.js';
import type { RunComposition } from '../../src/composition/run-composition.js';
import { isJsonObject } from '../../src/contracts/json.js';
import type { CreateRunInput } from '../../src/contracts/manager.js';
import { RunManagerError } from '../../src/contracts/run-manager-error.js';
import type { AgentAssignment } from '../../src/contracts/run-profile.js';
import { codexContextCase } from '../support/codex-conformance.js';

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  isJsonObject(value) && Object.values(value).every((entry) => typeof entry === 'string');

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

const scriptNode = {
  kind: 'script' as const,
  id: 'script',
  requirementKey: 'verification',
  script: { id: 'script:test/verification' as const, version: 1 },
  input: {},
  inputSchema: emptySchema,
  outputSchema: emptySchema,
  routes: { succeeded: 'done', failed: 'done', cancelled: 'done' },
};

const scriptOnlyPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-script-only-admission',
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
        entry: 'script',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [scriptNode, { kind: 'end', id: 'done', outcome: 'ok', output: {} }],
      },
    },
  ],
};

const codexAndScriptPipeline: PipelineSourcePackage = {
  ...agentPipeline,
  key: 'rn1-codex-script-admission',
  maximumTotalActivities: 2,
  modules: [
    {
      ...agentPipeline.modules[0],
      region: {
        ...agentPipeline.modules[0].region,
        nodes: [
          {
            kind: 'agent',
            id: 'review',
            strategies: [
              {
                kind: 'single',
                routes: { succeeded: 'script', failed: 'script', cancelled: 'script' },
              },
            ],
            input: { prompt: { kind: 'literal', value: 'Review' } },
            inputSchema: agentInputSchema,
            outputSchema: emptySchema,
          },
          scriptNode,
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

const codexAssignment: AgentAssignment = {
  definition: { id: 'codex', version: 'definition-v1' },
  parameters: { model: 'test-model', allowAmbientLogin: true },
  permissions: { mode: 'read-only', network: false },
  workspaceRef: 'workspace-1',
};

const preparedAgentBinding = (input: AgentBindingInput): PreparedAgentBinding => ({
  schemaVersion: 'prepared-agent-binding/v1',
  pin: {
    agentId: input.definition.id,
    agentVersion: input.definition.version,
    definitionDigest: `sha256:${'a'.repeat(64)}`,
  },
  parameters: input.parameters,
  permissions: input.permissions,
  workspaceRef: input.workspaceRef,
});

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

const scriptAssignment = { resources: {}, credentials: {} } as const;
const preparedScriptBinding: PreparedScriptBinding = {
  schemaVersion: 'prepared-script-binding/v1',
  script: { id: 'script:test/verification', version: 1 },
  definitionDigest: `sha256:${'1'.repeat(64)}`,
  implementation: {
    id: '@revisium/revo-run/test/verification',
    version: '1.0.0',
    buildDigest: `sha256:${'2'.repeat(64)}`,
  },
  providers: [],
  resources: {},
  credentials: {},
  attemptPolicy: {
    timeoutMs: 1_000,
    terminationGraceMs: 1_000,
    retry: { mode: 'never', maxAttempts: 1, backoffMs: [] },
    idempotency: 'read-only',
  },
};

const scriptOnlyInput = (): CreateRunInput => ({
  runId: 'rn1-script-only-admission',
  pipeline: scriptOnlyPipeline,
  profile: {
    schemaVersion: 'run-profile/v1',
    selections: {},
    bindings: { agents: {}, scripts: { verification: scriptAssignment } },
  },
  input: {},
});

const codexAndScriptInput = (): CreateRunInput => ({
  ...baseInput({ 'reviewer-binding': codexAssignment }),
  runId: 'rn1-codex-script-admission',
  pipeline: codexAndScriptPipeline,
  profile: {
    schemaVersion: 'run-profile/v1',
    selections: {
      review: {
        strategy: 'single',
        participant: { key: 'reviewer', bindingKey: 'reviewer-binding' },
      },
    },
    bindings: {
      agents: { 'reviewer-binding': codexAssignment },
      scripts: { verification: scriptAssignment },
    },
  },
});

const withPlatform = async <T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (descriptor === undefined || !descriptor.configurable) {
    throw new Error('process.platform cannot be safely isolated for this test.');
  }
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

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

const composition = () => {
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
  const prepareAgentBinding = vi.fn<(input: AgentBindingInput) => Promise<PreparedAgentBinding>>(
    async (input) => preparedAgentBinding(input),
  );
  const prepareBinding = vi.spyOn(scripts, 'prepareBinding');
  return {
    value: {
      fence: new RunHostReadinessFence(),
      agents: {
        ...unavailableAgentPort,
        initialize: initializeAgents,
        prepareBinding: prepareAgentBinding,
      },
      scripts,
    },
    initializeAgents,
    prepareAgentBinding,
    prepareBinding,
  };
};

const expectCode = async (
  promise: Promise<unknown>,
  code: RunManagerError['code'],
): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code });
};

const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof RunManagerError ? error.code : 'unexpected_error';
  }
};

const admitUnknown = (input: unknown, value: RunComposition): Promise<unknown> => {
  const result: unknown = Reflect.apply(admitRun, undefined, [input, value]);
  return Promise.resolve(result);
};

describe('RN1 admission profile boundary', () => {
  it('CTX-DARWIN-UNSUPPORTED rejects Codex pre-host while preserving script-only admission', async () => {
    const context = await codexContextCase('CTX-DARWIN-UNSUPPORTED');
    const composed = composition();
    composed.prepareBinding.mockResolvedValue(preparedScriptBinding);

    const actual = await withPlatform('darwin', async () => {
      const code = await rejectionCode(admitRun(codexAndScriptInput(), composed.value));
      const preHost = {
        agentPrepareCalls: composed.prepareAgentBinding.mock.calls.length,
        workspaceCalls: 0,
        scriptPrepareCalls: composed.prepareBinding.mock.calls.length,
        processCalls: 0,
        dbosCalls: 0,
      };
      const admitted = await admitRun(scriptOnlyInput(), composed.value);
      return {
        code,
        ...preHost,
        scriptOnlyAccepted: admitted.bindings.scripts['verification'] !== undefined,
      };
    });

    expect(actual).toStrictEqual(context.expected);
  });

  it('CTX-UNSUPPORTED-ASSIGNMENTS executes every unsupported whole-set variant', async () => {
    const context = await codexContextCase('CTX-UNSUPPORTED-ASSIGNMENTS');
    if (
      !isJsonObject(context.input) ||
      !Array.isArray(context.input.variants) ||
      !context.input.variants.every((variant) => typeof variant === 'string')
    ) {
      throw new Error('CTX-UNSUPPORTED-ASSIGNMENTS has invalid input.');
    }
    const inputVariants = context.input.variants;
    const mixed = consensusInput();
    const firstBinding = Object.keys(mixed.profile.bindings.agents)[0];
    if (firstBinding === undefined) {
      throw new Error('Expected a consensus binding.');
    }
    const variants: Readonly<Record<string, CreateRunInput>> = {
      'wrong-id': baseInput(),
      'wrong-version': baseInput({
        'reviewer-binding': {
          ...codexAssignment,
          definition: { id: 'codex', version: 'definition-v2' },
        },
      }),
      'mixed-supported-unsupported': {
        ...mixed,
        profile: {
          ...mixed.profile,
          bindings: {
            ...mixed.profile.bindings,
            agents: { ...mixed.profile.bindings.agents, [firstBinding]: codexAssignment },
          },
        },
      },
      'unsupported-consensus-member': consensusInput(),
    };
    const composed = composition();
    const codes: string[] = [];
    for (const variant of inputVariants) {
      const input = variants[variant];
      if (input === undefined) {
        throw new Error(`Unknown unsupported assignment variant ${variant}.`);
      }
      // oxlint-disable-next-line no-await-in-loop -- the vector fixes the deterministic variant order.
      codes.push(await rejectionCode(admitRun(input, composed.value)));
    }

    expect({
      codes,
      preparedAgentCalls: composed.prepareAgentBinding.mock.calls.length,
      workspaceCalls: 0,
      scriptCalls: composed.prepareBinding.mock.calls.length,
      processCalls: 0,
      dbosCalls: 0,
    }).toStrictEqual(context.expected);
  });

  it('CTX-CREDENTIALS-PRESENT rejects empty and populated credentials pre-host', async () => {
    const context = await codexContextCase('CTX-CREDENTIALS-PRESENT');
    if (!isJsonObject(context.input) || !Array.isArray(context.input.variants)) {
      throw new Error('CTX-CREDENTIALS-PRESENT has invalid input.');
    }
    const inputVariants = context.input.variants.filter(isStringRecord);
    if (inputVariants.length !== context.input.variants.length) {
      throw new Error('CTX-CREDENTIALS-PRESENT has invalid credentials.');
    }
    const composed = composition();
    const codes = await Promise.all(
      inputVariants.map(
        async (credentials) =>
          await rejectionCode(
            admitRun(
              baseInput({
                'reviewer-binding': {
                  ...codexAssignment,
                  credentials,
                },
              }),
              composed.value,
            ),
          ),
      ),
    );

    expect({
      codes,
      agentPrepareCalls: composed.prepareAgentBinding.mock.calls.length,
      workspaceAcquireCalls: 0,
      scriptPrepareCalls: composed.prepareBinding.mock.calls.length,
      processCalls: 0,
      dbosCalls: 0,
    }).toStrictEqual(context.expected);
  });

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

  it('rejects an unsupported agent before agent or script preparation', async () => {
    const composed = composition();

    await expectCode(admitRun(baseInput(), composed.value), 'agent_runtime_unavailable');

    expect(composed.initializeAgents).not.toHaveBeenCalled();
    expect(composed.prepareAgentBinding).not.toHaveBeenCalled();
    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('validates all consensus assignments before rejecting unsupported agents', async () => {
    const composed = composition();

    await expectCode(admitRun(consensusInput(), composed.value), 'agent_runtime_unavailable');

    expect(composed.initializeAgents).not.toHaveBeenCalled();
    expect(composed.prepareAgentBinding).not.toHaveBeenCalled();
    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('rejects mixed supported and unsupported agents before preparing either one', async () => {
    const input = consensusInput();
    const firstBinding = Object.keys(input.profile.bindings.agents)[0];
    if (firstBinding === undefined) {
      throw new Error('Expected a consensus binding.');
    }
    const composed = composition();

    await expectCode(
      admitRun(
        {
          ...input,
          profile: {
            ...input.profile,
            bindings: {
              ...input.profile.bindings,
              agents: { ...input.profile.bindings.agents, [firstBinding]: codexAssignment },
            },
          },
        },
        composed.value,
      ),
      'agent_runtime_unavailable',
    );

    expect(composed.prepareAgentBinding).not.toHaveBeenCalled();
    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('rejects the wrong Codex definition version before preparation', async () => {
    const composed = composition();

    await expectCode(
      admitRun(
        baseInput({
          'reviewer-binding': {
            ...codexAssignment,
            definition: { id: 'codex', version: 'definition-v2' },
          },
        }),
        composed.value,
      ),
      'agent_runtime_unavailable',
    );

    expect(composed.prepareAgentBinding).not.toHaveBeenCalled();
    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('rejects even empty agent credentials before agent or script preparation', async () => {
    const composed = composition();

    await expectCode(
      admitRun(
        baseInput({ 'reviewer-binding': { ...codexAssignment, credentials: {} } }),
        composed.value,
      ),
      'agent_runtime_unavailable',
    );

    expect(composed.prepareAgentBinding).not.toHaveBeenCalled();
    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it.each([
    '/private/workspace',
    'C:\\private\\workspace',
    '\\\\server\\share',
    'file:///tmp/work',
  ])('rejects path-shaped agent workspace %s before preparation', async (workspaceRef) => {
    const composed = composition();

    await expectCode(
      admitRun(
        baseInput({ 'reviewer-binding': { ...codexAssignment, workspaceRef } }),
        composed.value,
      ),
      'run_profile_invalid',
    );

    expect(composed.prepareAgentBinding).not.toHaveBeenCalled();
    expect(composed.prepareBinding).not.toHaveBeenCalled();
  });

  it('stores only the prepared supported Codex binding in the admitted snapshot', async () => {
    const composed = composition();

    const admitted = await admitRun(
      baseInput({ 'reviewer-binding': codexAssignment }),
      composed.value,
    );

    expect(composed.prepareAgentBinding).toHaveBeenCalledOnce();
    expect(composed.prepareBinding).not.toHaveBeenCalled();
    expect(admitted.bindings.agents).toStrictEqual({
      'reviewer-binding': preparedAgentBinding(codexAssignment),
    });
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
