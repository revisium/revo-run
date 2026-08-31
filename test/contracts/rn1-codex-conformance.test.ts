import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type {
  ActiveInvocationStateSink,
  AgentInvocationResult,
} from '@revisium/revo-agent-runtime';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { AgentBindingInput } from '../../src/composition/agent-port.js';
import { createCodexAgentRuntimePort } from '../../src/composition/agents/codex/codex-agent-runtime-port.js';
import {
  CODEX_AGENT_DEFINITION,
  CODEX_AGENT_REF,
} from '../../src/composition/agents/codex/codex-definition.js';
import { sanitizeAgentTerminalResult } from '../../src/composition/agents/codex/codex-result-mapper.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../src/contracts/json.js';
import { runManagerStopOrder } from '../../src/manager/run-manager.js';
import {
  expandTerminalPathContextInput,
  loadCodexConformance,
  type GoldenVector,
  type SourceRequirements,
} from '../support/codex-conformance.js';

const execFileAsync = promisify(execFile);
const conformance = await loadCodexConformance();
const hash = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');
const rootBytes = async (path: string): Promise<Buffer> =>
  await readFile(new URL(`../../${path}`, import.meta.url));
const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isJsonObject(value)) {
    throw new Error('Expected an object in a conformance evaluator.');
  }
  return value;
};
const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  return value;
};
const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  isJsonObject(value) && Object.values(value).every((item) => typeof item === 'string');
const requiredStringRecord = (value: unknown): Readonly<Record<string, string>> => {
  if (!isStringRecord(value)) {
    throw new Error('Credentials vector must contain only strings.');
  }
  return value;
};

const sink: ActiveInvocationStateSink = {
  save: async () => undefined,
  remove: async () => undefined,
};
const binding = (overrides: Partial<AgentBindingInput> = {}): AgentBindingInput => ({
  definition: CODEX_AGENT_REF,
  parameters: { model: 'test-model', allowAmbientLogin: true },
  permissions: { mode: 'read-only', network: false },
  workspaceRef: 'Workspace_1.prod',
  ...overrides,
});
const prepareOutcome = async (input: AgentBindingInput): Promise<'accepted' | 'rejected'> => {
  const port = createCodexAgentRuntimePort(
    {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('Pure conformance vectors cannot acquire a workspace.');
      },
    },
    sink,
  );
  await port.initialize([]);
  try {
    await port.prepareBinding(input);
    return 'accepted';
  } catch {
    return 'rejected';
  } finally {
    await port.shutdown('conformance-vector');
  }
};
const runtimeSuccess = (value: JsonObject): AgentInvocationResult => ({
  schemaVersion: 'agent-invocation-result/v1',
  invocationId: 'golden-terminal',
  pin: { agentId: 'codex', agentVersion: 'definition-v1', definitionDigest: 'a'.repeat(64) },
  launch: { executable: '/private/codex', reportedVersion: '1.2.3' },
  acceptedAt: '2026-08-30T00:00:00.000Z',
  startedAt: '2026-08-30T00:00:00.000Z',
  finishedAt: '2026-08-30T00:00:01.000Z',
  durationMs: 1_000,
  exit: { code: 0, signal: null },
  files: {
    directory: '/private/output',
    events: 'events.ndjson',
    stdout: 'stdout.log',
    stderr: 'stderr.log',
    result: 'result.json',
  },
  status: 'succeeded',
  value,
});
const literalArguments = (): readonly string[] =>
  CODEX_AGENT_DEFINITION.launch.args.flatMap((argument) =>
    argument.kind === 'literal' ? [argument.value] : [],
  );
const evaluateTerminal = (input: JsonValue): string => {
  if (!isJsonObject(input)) {
    throw new Error('Terminal vector input must be an object.');
  }
  return sanitizeAgentTerminalResult(runtimeSuccess(input)).status;
};
const evaluateGolden = async (vector: GoldenVector): Promise<unknown> => {
  switch (vector.kind) {
    case 'definition-platforms':
      return CODEX_AGENT_DEFINITION.constraints.platforms;
    case 'definition-prompt-delivery':
      return CODEX_AGENT_DEFINITION.delivery.prompt;
    case 'definition-argv-suffix':
      return literalArguments().slice(-2);
    case 'definition-argv-prefix':
      return literalArguments().slice(0, 3);
    case 'definition-literal':
      return literalArguments().find((item) => item === vector.expected);
    case 'definition-ambient-login':
      return CODEX_AGENT_DEFINITION.parameters.schema.properties.allowAmbientLogin.const;
    case 'definition-no-cli-pin':
      return !Object.hasOwn(CODEX_AGENT_DEFINITION.constraints, 'executableVersion');
    case 'definition-argument-template':
      return CODEX_AGENT_DEFINITION.launch.args;
    case 'binding-credentials-omitted':
      return await prepareOutcome(binding());
    case 'binding-model':
      return await prepareOutcome(
        binding({
          parameters: {
            model: requiredString(vector.input, `${vector.id} model`),
            allowAmbientLogin: true,
          },
        }),
      );
    case 'binding-credentials':
      return await prepareOutcome(binding({ credentials: requiredStringRecord(vector.input) }));
    case 'binding-workspace':
      return await prepareOutcome(
        binding({ workspaceRef: requiredString(vector.input, `${vector.id} workspace`) }),
      );
    case 'binding-workspace-set':
      if (!Array.isArray(vector.input)) {
        throw new Error('Workspace set must be an array.');
      }
      return (
        await Promise.all(
          vector.input.map(
            async (item) =>
              await prepareOutcome(
                binding({ workspaceRef: requiredString(item, `${vector.id} workspace`) }),
              ),
          ),
        )
      ).every((item) => item === vector.expected)
        ? vector.expected
        : 'mixed';
    case 'terminal-value':
      return evaluateTerminal(vector.input ?? null);
    case 'terminal-value-set':
      if (!Array.isArray(vector.input)) {
        throw new Error('Terminal set must be an array.');
      }
      return vector.input.map(evaluateTerminal).every((item) => item === vector.expected)
        ? vector.expected
        : 'mixed';
    case 'terminal-context-case': {
      const caseId = requiredString(vector.input, `${vector.id} context case`);
      const context = conformance.context.cases.find(({ id }) => id === caseId);
      if (context === undefined) {
        throw new Error(`${vector.id} references an invalid terminal context case.`);
      }
      const vectors = expandTerminalPathContextInput(context.input);
      const unsafePassed = vectors.unsafe.every(
        (value) => evaluateTerminal({ value }) === 'failed',
      );
      const safePassed = vectors.safe.every((value) => evaluateTerminal({ value }) === 'succeeded');
      return unsafePassed && safePassed ? 'passed' : 'failed';
    }
    case 'manager-stop-order':
      return runManagerStopOrder;
    default:
      throw new Error(`Unsupported golden kind ${vector.kind}.`);
  }
};

type SourceRow = SourceRequirements['sources'][number];
type SourceEvidence = NonNullable<SourceRow['immutabilityEvidence']>[number];

const verifyEvidence = async (evidence: SourceEvidence): Promise<void> => {
  if (evidence.kind === 'file-sha256') {
    const actual = hash(await rootBytes(evidence.locator));
    if (actual !== evidence.value) {
      throw new Error(`Installed source evidence ${evidence.locator} does not match its pin.`);
    }
  }
  if (evidence.kind === 'git-tree') {
    const commit = /[a-f0-9]{40}/u.exec(evidence.locator)?.[0];
    if (commit === undefined) {
      throw new Error('Git tree evidence has no commit locator.');
    }
    const value = await execFileAsync('git', ['rev-parse', `${commit}^{tree}`]);
    if (value.stdout.trim() !== evidence.value) {
      throw new Error('Git tree evidence does not match its pin.');
    }
  }
};

const verifySource = async (source: SourceRow): Promise<string> => {
  if (/approved.run.artifact|architecture_plan|task_spec/iu.test(source.locator)) {
    throw new Error(`Source ${source.id} has a mutable locator.`);
  }
  if (source.immutablePin.kind.includes('published-version')) {
    throw new Error(`Source ${source.id} uses a forbidden published-version pin.`);
  }
  if (
    source.immutablePin.kind === 'file-sha256' &&
    hash(await rootBytes(source.locator)) !== source.immutablePin.value
  ) {
    throw new Error(`Source ${source.id} does not match its file pin.`);
  }
  if (
    source.immutablePin.kind === 'normalized-sha256' &&
    source.immutablePin.value !== conformance.architecture.normalizedTextSha256
  ) {
    throw new Error(`Source ${source.id} does not match the architecture normalization.`);
  }
  if (source.immutablePin.kind === 'sri-sha512') {
    const lock = record(parse((await rootBytes('pnpm-lock.yaml')).toString('utf8')));
    const resolution = record(
      record(record(lock['packages'])['@revisium/revo-agent-runtime@0.1.0-alpha.0'])['resolution'],
    );
    if (resolution['integrity'] !== `sha512-${source.immutablePin.value}`) {
      throw new Error(`Source ${source.id} does not match its registry SRI.`);
    }
  }
  if (source.immutablePin.kind === 'git-commit') {
    const value = await execFileAsync('git', [
      'rev-parse',
      `${source.immutablePin.value}^{commit}`,
    ]);
    if (value.stdout.trim() !== source.immutablePin.value) {
      throw new Error(`Source ${source.id} does not match its commit pin.`);
    }
  }
  await Promise.all((source.immutabilityEvidence ?? []).map(verifyEvidence));
  return source.id;
};

describe('RN1 Codex governing conformance', () => {
  it('validates the approved architecture normalization and stable identifiers', () => {
    const constraints = [...conformance.architecture.constraints].sort(
      (a, b) => a.ordinal - b.ordinal,
    );
    expect(constraints.map(({ ordinal }) => ordinal)).toStrictEqual(
      Array.from({ length: 17 }, (_, index) => index + 1),
    );
    expect(new Set(constraints.map(({ id }) => id)).size).toBe(constraints.length);
    expect(hash(constraints.map(({ ordinal, text }) => `${ordinal}. ${text}`).join('\n'))).toBe(
      conformance.architecture.normalizedTextSha256,
    );
  });

  it('resolves every immutable source pin without a published-version claim', async () => {
    const sourceIds = new Set(conformance.requirements.sources.map(({ id }) => id));
    expect(sourceIds.size).toBe(conformance.requirements.sources.length);
    expect(await Promise.all(conformance.requirements.sources.map(verifySource))).toStrictEqual(
      conformance.requirements.sources.map(({ id }) => id),
    );
  });

  it('maps every atomic requirement through its declared evidence class', () => {
    const sources = new Set(conformance.requirements.sources.map(({ id }) => id));
    const requirementRows = new Map(
      conformance.requirements.requirements.map((requirement) => [requirement.id, requirement]),
    );
    const requirements = new Set(requirementRows.keys());
    expect(requirements.size).toBe(conformance.requirements.requirements.length);
    for (const requirement of conformance.requirements.requirements) {
      expect(sources.has(requirement.sourceId)).toBe(true);
      expect(requirement.locator).toMatch(/^\//u);
    }
    const executableCovered = new Set([
      ...conformance.golden.flatMap(({ requirements: values }) => values),
      ...conformance.context.cases.flatMap(({ requirements: values }) => values),
    ]);
    const routeGateCovered = new Set(
      conformance.requirements.routeGates.flatMap(({ requirements: values }) => values),
    );
    const exclusionCovered = new Set(
      conformance.context.exclusions.flatMap(({ requirements: values }) => values),
    );
    const channel = {
      'executable-vector': executableCovered,
      'route-gate': routeGateCovered,
      'source-backed-exclusion': exclusionCovered,
    } as const;
    expect(
      [...requirementRows.values()]
        .filter((requirement) => !channel[requirement.evidenceClass].has(requirement.id))
        .map(({ id }) => id),
    ).toStrictEqual([]);
    for (const id of executableCovered) {
      expect(requirementRows.get(id)?.evidenceClass).toBe('executable-vector');
    }
    for (const id of routeGateCovered) {
      expect(requirementRows.get(id)?.evidenceClass).toBe('route-gate');
    }
    for (const id of exclusionCovered) {
      expect(requirementRows.get(id)?.evidenceClass).toBe('source-backed-exclusion');
    }
  });

  it('validates closed context coordinates, evidence, and source-backed exclusions', () => {
    const axes = Object.entries(conformance.context.axes);
    const requirements = new Set(conformance.requirements.requirements.map(({ id }) => id));
    const sources = new Set(conformance.requirements.sources.map(({ id }) => id));
    for (const value of conformance.context.cases) {
      for (const [axis, coordinate] of Object.entries(value.coordinates)) {
        expect(axes.find(([name]) => name === axis)?.[1]).toContain(coordinate);
      }
      expect(value.requirements.every((id) => requirements.has(id))).toBe(true);
      expect(Object.keys(value.evidence).toSorted()).toStrictEqual(['consumer', 'evidenceClass']);
      expect(value.evidence.evidenceClass).toBe('executable-vector');
      expect(JSON.stringify(value.evidence)).not.toMatch(
        /marker|contains|test.?title|source.?text/iu,
      );
    }
    for (const exclusion of conformance.context.exclusions) {
      expect(exclusion.reason.length).toBeGreaterThan(0);
      expect(exclusion.evidenceClass).toBe('source-backed-exclusion');
      expect(exclusion.sourceIds.every((id) => sources.has(id))).toBe(true);
    }
  });

  it('pins the exact 19 executable case and evaluator pairs', () => {
    expect(
      conformance.context.cases.map(({ id, evidence }) => [id, evidence.consumer]),
    ).toStrictEqual([
      ['CTX-DEP-EXACT', 'test/contracts/registry-dependency-contract.test.ts'],
      ['CTX-SURFACE-PRIVATE', 'scripts/verify-package.mjs'],
      ['CTX-DARWIN-UNSUPPORTED', 'test/contracts/admission.test.ts'],
      ['CTX-UNSUPPORTED-ASSIGNMENTS', 'test/contracts/admission.test.ts'],
      ['CTX-ARGV-STDIN', 'test/integration/rn1-codex-agent-runtime-port.test.ts'],
      ['CTX-CREDENTIALS-OMITTED', 'test/contracts/rn1-codex-conformance.test.ts'],
      ['CTX-CREDENTIALS-PRESENT', 'test/contracts/admission.test.ts'],
      ['CTX-WORKSPACE-PER-INVOCATION', 'test/integration/rn1-codex-agent-runtime-port.test.ts'],
      ['CTX-TERMINAL-ACRONYMS', 'test/contracts/codex-terminal-result.test.ts'],
      ['CTX-TERMINAL-EMBEDDED-PATHS', 'test/contracts/codex-terminal-result.test.ts'],
      ['CTX-PENDING-CANCEL', 'test/integration/rn1-codex-agent-runtime-port.test.ts'],
      ['CTX-PENDING-SHUTDOWN', 'test/integration/rn1-codex-agent-runtime-port.test.ts'],
      ['CTX-START-CLASSIFICATION', 'test/integration/rn1-private-agent-port.test.ts'],
      ['CTX-ACTIVE-RECOVERY', 'test/integration/rn1-codex-agent-recovery-process.test.ts'],
      ['CTX-TERMINAL-NO-REPLAY', 'test/integration/rn1-codex-agent-dbos.test.ts'],
      ['CTX-MANAGER-STOP-ORDER', 'test/integration/rn1-codex-agent-dbos.test.ts'],
      ['CTX-CONFORMANCE-ARTIFACTS', 'test/contracts/rn1-codex-conformance.test.ts'],
      ['CTX-DEP-REJECT-ALTERNATES', 'test/contracts/registry-dependency-contract.test.ts'],
      ['CTX-AMBIENT-AUTH-PER-INVOCATION', 'test/integration/rn1-codex-agent-runtime-port.test.ts'],
    ]);
  });

  it('binds every terminal path golden to the one canonical context set', () => {
    expect(
      conformance.golden
        .filter(({ id }) =>
          [
            'GV-TERMINAL-FILE-URI',
            'GV-TERMINAL-EMBEDDED-POSIX-PATH',
            'GV-TERMINAL-SAFE-RELATIVE-PATH',
          ].includes(id),
        )
        .map(({ kind, input }) => ({ kind, input })),
    ).toStrictEqual(
      Array.from({ length: 3 }, () => ({
        kind: 'terminal-context-case',
        input: 'CTX-TERMINAL-EMBEDDED-PATHS',
      })),
    );
  });

  it.each(conformance.golden)('$id executes its pure observation', async (vector) => {
    expect(await evaluateGolden(vector)).toStrictEqual(vector.expected);
  });

  it('CTX-CREDENTIALS-OMITTED executes private binding preparation', async () => {
    const context = conformance.context.cases.find(({ id }) => id === 'CTX-CREDENTIALS-OMITTED');
    if (context === undefined) {
      throw new Error('Missing CTX-CREDENTIALS-OMITTED.');
    }
    expect({ prepared: (await prepareOutcome(binding())) === 'accepted' }).toStrictEqual(
      context.expected,
    );
  });

  it('directly evaluates the exact registry dependency context', async () => {
    const value = conformance.context.cases.find(({ id }) => id === 'CTX-DEP-EXACT');
    if (value === undefined) {
      throw new Error('Missing CTX-DEP-EXACT.');
    }
    const input = record(value.input);
    const manifest = record(JSON.parse((await rootBytes('package.json')).toString('utf8')));
    const lock = record(parse((await rootBytes('pnpm-lock.yaml')).toString('utf8')));
    const packages = record(lock['packages']);
    const importer = record(record(record(lock['importers'])['.'])['dependencies']);
    const packageName = String(input['package']);
    const version = String(input['version']);
    const resolution = record(record(packages[`${packageName}@${version}`])['resolution']);
    expect({
      accepted:
        record(manifest['dependencies'])[packageName] === version &&
        record(importer[packageName])['version'] === version &&
        resolution['integrity'] === input['integrity'],
      resolutionCount: Object.keys(packages).filter((key) => key.startsWith(`${packageName}@`))
        .length,
      importer: 'root',
    }).toStrictEqual(value.expected);
  });

  it('CTX-CONFORMANCE-ARTIFACTS executes closed artifact and coverage evaluation', async () => {
    const context = conformance.context.cases.find(({ id }) => id === 'CTX-CONFORMANCE-ARTIFACTS');
    if (context === undefined) {
      throw new Error('Missing CTX-CONFORMANCE-ARTIFACTS.');
    }
    const artifactLines: string[] = [];
    let artifactDigestsMatch = true;
    for (const artifact of conformance.manifest.artifacts) {
      // oxlint-disable-next-line no-await-in-loop -- manifest order owns the combined digest.
      const digest = hash(await rootBytes(artifact.path));
      artifactDigestsMatch &&= digest === artifact.digest;
      artifactLines.push(`${digest}  ${artifact.path}\n`);
    }
    const sourcePins = await Promise.all(conformance.requirements.sources.map(verifySource));
    const axes = Object.entries(conformance.context.axes);
    const coordinatesValidated = conformance.context.cases.every((value) =>
      Object.entries(value.coordinates).every(([axis, coordinate]) =>
        coordinate === undefined
          ? false
          : axes.find(([name]) => name === axis)?.[1].includes(coordinate),
      ),
    );
    const covered = new Set([
      ...conformance.golden.flatMap(({ requirements }) => requirements),
      ...conformance.context.cases.flatMap(({ requirements }) => requirements),
      ...conformance.requirements.routeGates.flatMap(({ requirements }) => requirements),
      ...conformance.context.exclusions.flatMap(({ requirements }) => requirements),
    ]);

    expect({
      closedSchemas: true,
      digestPinned:
        sourcePins.length === conformance.requirements.sources.length &&
        artifactDigestsMatch &&
        hash(artifactLines.join('')) === conformance.manifest.governingArtifactsDigest,
      coordinatesValidated,
      requirementsCovered: conformance.requirements.requirements.every(({ id }) => covered.has(id)),
    }).toStrictEqual(context.expected);
  });

  it('matches every governing artifact byte digest and ordered combined digest', async () => {
    const lines: string[] = [];
    for (const artifact of conformance.manifest.artifacts) {
      // oxlint-disable-next-line no-await-in-loop -- manifest order owns the combined digest.
      const digest = hash(await rootBytes(artifact.path));
      expect(digest).toBe(artifact.digest);
      lines.push(`${digest}  ${artifact.path}\n`);
    }
    expect(hash(lines.join(''))).toBe(conformance.manifest.governingArtifactsDigest);
  });
});
