import { randomUUID } from 'node:crypto';

import {
  compilePipeline,
  type AgentProgramRequirement,
  type PipelineCompileResult,
  type ProgramRequirement,
} from '@revisium/revo-pipeline';
import { createInitialPipelineState } from '@revisium/revo-pipeline/kernel';
import type { PreparedScriptBinding, ScriptIdentityPin } from '@revisium/revo-scripts';
import { Check } from 'typebox/value';

import { CODEX_AGENT_REF } from '../composition/agents/codex/codex-definition.js';
import type { RunComposition } from '../composition/run-composition.js';
import type { AdmittedRunSnapshotV1 } from '../contracts/admitted-run.js';
import { isJsonValue, type JsonValue } from '../contracts/json.js';
import type { CreateRunInput } from '../contracts/manager.js';
import { RunIdSchema } from '../contracts/public-schemas.js';
import { RunManagerError, pipelineCompilationError } from '../contracts/run-manager-error.js';
import {
  RunProfileSchema,
  type AgentAssignment,
  type ScriptAssignment,
} from '../contracts/run-profile.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const logicalWorkspaceRefPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

const isLogicalWorkspaceRef = (value: unknown): value is string =>
  typeof value === 'string' && logicalWorkspaceRefPattern.test(value);

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  isRecord(value) && Object.values(value).every(isNonEmptyString);

const isJsonRecord = (value: unknown): value is Readonly<Record<string, JsonValue>> =>
  isRecord(value) && Object.values(value).every(isJsonValue);

const isScriptAssignment = (value: unknown): value is ScriptAssignment =>
  isRecord(value) &&
  isRecord(value.resources) &&
  Object.values(value.resources).every(
    (resource) =>
      isRecord(resource) &&
      isNonEmptyString(resource.resourceRef) &&
      (resource.workspaceRef === undefined || isNonEmptyString(resource.workspaceRef)),
  ) &&
  isStringRecord(value.credentials);

const isAgentAssignment = (value: unknown): value is AgentAssignment =>
  isRecord(value) &&
  isRecord(value.definition) &&
  isNonEmptyString(value.definition.id) &&
  isNonEmptyString(value.definition.version) &&
  isJsonRecord(value.parameters) &&
  isJsonRecord(value.permissions) &&
  isLogicalWorkspaceRef(value.workspaceRef) &&
  (value.credentials === undefined || isStringRecord(value.credentials));

const isValidEnvelope = (input: CreateRunInput): boolean =>
  isRecord(input) &&
  typeof input.runId === 'string' &&
  isRecord(input.pipeline) &&
  isRecord(input.profile) &&
  input.profile.schemaVersion === 'run-profile/v1' &&
  isRecord(input.profile.bindings) &&
  isRecord(input.profile.bindings.agents) &&
  isRecord(input.profile.bindings.scripts) &&
  isRecord(input.profile.selections) &&
  isJsonValue(input.input);

interface ResolvedProfile {
  readonly agents: readonly [AgentProgramRequirement, AgentAssignment][];
  readonly scripts: readonly [
    string,
    ProgramRequirement & { readonly kind: 'script' },
    ScriptAssignment,
  ][];
}

type ScriptProgramRequirement = ProgramRequirement & { readonly kind: 'script' };

const profileInvalid = (path: string, reason: string): never => {
  throw new RunManagerError('run_profile_invalid', { path, reason });
};

const rejectInvalidAgentWorkspaceRefs = (assignments: Readonly<Record<string, unknown>>): void => {
  for (const [bindingKey, assignment] of Object.entries(assignments)) {
    if (
      isRecord(assignment) &&
      Object.hasOwn(assignment, 'workspaceRef') &&
      !isLogicalWorkspaceRef(assignment.workspaceRef)
    ) {
      profileInvalid(`/bindings/agents/${bindingKey}/workspaceRef`, 'logical_reference_grammar');
    }
  }
};

const resolveAgentRequirement = (
  requirement: AgentProgramRequirement,
  assignments: Readonly<Record<string, AgentAssignment>>,
  knownKeys: Set<string>,
): readonly [AgentProgramRequirement, AgentAssignment] => {
  const bindingKey = requirement.bindingKey;
  if (knownKeys.has(bindingKey)) {
    profileInvalid('/bindings/agents', 'duplicate_requirement');
  }
  const assignment = assignments[bindingKey];
  if (assignment === undefined) {
    throw new RunManagerError('run_requirement_unresolved', {
      requirementKey: requirement.key,
      bindingKey,
      reason: 'missing_agent_assignment',
    });
  }
  if (!isAgentAssignment(assignment)) {
    profileInvalid(`/bindings/agents/${bindingKey}`, 'invalid_assignment');
  }
  knownKeys.add(bindingKey);
  return [requirement, assignment];
};

const resolveScriptRequirement = (
  requirement: ScriptProgramRequirement,
  assignments: Readonly<Record<string, ScriptAssignment>>,
  knownKeys: Set<string>,
): readonly [string, ScriptProgramRequirement, ScriptAssignment] => {
  const requirementKey = requirement.key;
  if (knownKeys.has(requirementKey)) {
    profileInvalid('/bindings/scripts', 'duplicate_requirement');
  }
  const assignment = assignments[requirementKey];
  if (assignment === undefined) {
    throw new RunManagerError('run_requirement_unresolved', {
      requirementKey,
      bindingKey: null,
      reason: 'missing_script_assignment',
    });
  }
  if (!isScriptAssignment(assignment)) {
    profileInvalid(`/bindings/scripts/${requirementKey}`, 'invalid_assignment');
  }
  knownKeys.add(requirementKey);
  return [requirementKey, requirement, assignment];
};

const rejectExtraAssignments = (
  assignments: Readonly<Record<string, unknown>>,
  knownKeys: ReadonlySet<string>,
  path: '/bindings/agents' | '/bindings/scripts',
): void => {
  if (Object.keys(assignments).some((key) => !knownKeys.has(key))) {
    profileInvalid(path, 'extra_assignment');
  }
};

const resolveProfile = (
  requirements: readonly ProgramRequirement[],
  agents: Readonly<Record<string, AgentAssignment>>,
  scripts: Readonly<Record<string, ScriptAssignment>>,
): ResolvedProfile => {
  const knownAgentKeys = new Set<string>();
  const knownScriptKeys = new Set<string>();
  const resolvedAgents: [AgentProgramRequirement, AgentAssignment][] = [];
  const resolvedScripts: [
    string,
    ProgramRequirement & { readonly kind: 'script' },
    ScriptAssignment,
  ][] = [];
  for (const requirement of requirements) {
    if (requirement.kind === 'agent') {
      resolvedAgents.push([...resolveAgentRequirement(requirement, agents, knownAgentKeys)]);
      continue;
    }
    resolvedScripts.push([...resolveScriptRequirement(requirement, scripts, knownScriptKeys)]);
  }
  rejectExtraAssignments(agents, knownAgentKeys, '/bindings/agents');
  rejectExtraAssignments(scripts, knownScriptKeys, '/bindings/scripts');
  return Object.freeze({
    agents: Object.freeze(resolvedAgents),
    scripts: Object.freeze(resolvedScripts),
  });
};

const compilationOrThrow = (
  input: CreateRunInput,
): Extract<PipelineCompileResult, { readonly ok: true }> => {
  const compilation = compilePipeline(input.pipeline, input.profile.selections);
  if (!compilation.ok) {
    throw pipelineCompilationError(compilation.diagnostics);
  }
  return compilation;
};

const scriptPin = (value: { readonly id: string; readonly version: number }): ScriptIdentityPin => {
  if (!isScriptIdentity(value.id)) {
    throw new RunManagerError('run_profile_invalid', { path: '/pipeline', reason: 'script_pin' });
  }
  return { id: value.id, version: value.version };
};

const isScriptIdentity = (value: string): value is `script:${string}` =>
  value.startsWith('script:');

const isSupportedAgentAssignment = (assignment: AgentAssignment): boolean =>
  assignment.definition.id === CODEX_AGENT_REF.id &&
  assignment.definition.version === CODEX_AGENT_REF.version &&
  assignment.credentials === undefined;

export const admitRun = async (
  input: CreateRunInput,
  composition: RunComposition,
): Promise<AdmittedRunSnapshotV1> => {
  // The caller may have combined an invalid run ID with another malformed
  // field.  Extract and classify the ID before inspecting the rest of the
  // envelope so admission never reaches compilation or host preparation.
  if (isRecord(input) && typeof input.runId === 'string' && !Check(RunIdSchema, input.runId)) {
    throw new RunManagerError('invalid_run_id', { path: '/runId', reason: 'grammar' });
  }
  if (!isValidEnvelope(input)) {
    throw new RunManagerError('invalid_create_run_input', { path: '', reason: 'invalid_envelope' });
  }
  if (!Check(RunIdSchema, input.runId)) {
    throw new RunManagerError('invalid_run_id', { path: '/runId', reason: 'grammar' });
  }

  rejectInvalidAgentWorkspaceRefs(input.profile.bindings.agents);

  const compilation = compilationOrThrow(input);
  const initial = createInitialPipelineState(
    { program: compilation.program, programDigest: compilation.programDigest },
    input.input,
  );
  if (initial.state.status === 'failed') {
    throw new RunManagerError('invalid_create_run_input', {
      path: '/input',
      reason: 'entry_schema',
    });
  }
  if (!Check(RunProfileSchema, input.profile)) {
    profileInvalid('/profile', 'invalid_profile');
  }
  const assignments = resolveProfile(
    compilation.requirements.entries,
    input.profile.bindings.agents,
    input.profile.bindings.scripts,
  );
  if (assignments.agents.some(([, assignment]) => !isSupportedAgentAssignment(assignment))) {
    throw new RunManagerError('agent_runtime_unavailable');
  }
  if (assignments.agents.length > 0 && process.platform !== 'linux') {
    throw new RunManagerError('agent_runtime_unavailable');
  }

  const controller = new AbortController();
  const agentBindings: Record<
    string,
    Awaited<ReturnType<RunComposition['agents']['prepareBinding']>>
  > = {};
  for (const [requirement, assignment] of assignments.agents) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- first failed requirement must be deterministic at admission.
      agentBindings[requirement.bindingKey] = await composition.agents.prepareBinding(assignment);
    } catch {
      throw new RunManagerError('agent_runtime_unavailable');
    }
  }
  const bindings: Record<string, PreparedScriptBinding> = {};
  for (const [requirementKey, requirement, assignment] of assignments.scripts) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- first failed requirement must be deterministic at admission.
      bindings[requirementKey] = await composition.scripts.prepareBinding(
        {
          script: scriptPin(requirement.script),
          resources: assignment.resources,
          credentials: assignment.credentials,
        },
        { signal: controller.signal },
      );
    } catch {
      throw new RunManagerError('run_requirement_unresolved', {
        requirementKey,
        bindingKey: null,
        reason: 'script_binding_unavailable',
      });
    }
  }

  return Object.freeze({
    persistenceVersion: 1,
    runId: input.runId,
    raw: Object.freeze({
      pipeline: structuredClone(input.pipeline),
      profile: structuredClone(input.profile),
      input: structuredClone(input.input),
    }),
    compilation: Object.freeze({
      program: compilation.program,
      requirements: compilation.requirements,
      provenance: compilation.provenance,
      sourceDigest: compilation.sourceDigest,
      materializationDigest: compilation.materializationDigest,
      programDigest: compilation.programDigest,
    }),
    bindings: Object.freeze({
      scripts: Object.freeze(bindings),
      ...(Object.keys(agentBindings).length === 0 ? {} : { agents: Object.freeze(agentBindings) }),
    }),
    initial: Object.freeze({ state: initial.state, commands: initial.commands }),
    admission: Object.freeze({ createdAt: new Date().toISOString(), token: randomUUID() }),
  });
};
