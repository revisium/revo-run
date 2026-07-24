import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import {
  validateModuleStructure,
  type ArchitectureRule,
  type SourceModule,
} from './architecture/validate-module-structure.js';

const root = process.cwd();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const collectTypeScriptModules = async (
  directory: string,
  relativeRoot: string = root,
): Promise<readonly SourceModule[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = await Promise.all(
    entries.map(async (entry): Promise<readonly SourceModule[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptModules(path, relativeRoot);
      if (!entry.name.endsWith('.ts')) return [];

      return [
        {
          path: relative(relativeRoot, path).replaceAll('\\', '/'),
          source: await readFile(path, 'utf8'),
        },
      ];
    }),
  );

  return modules.flat();
};

const expectRuleFailure = (
  modules: readonly SourceModule[],
  expectedRule: ArchitectureRule,
): void => {
  assert.throws(
    () => validateModuleStructure(modules),
    (error: unknown) => error instanceof Error && error.message.startsWith(`[${expectedRule}]`),
    `Expected exact architecture failure from ${expectedRule}`,
  );
};

const writeFixtureFiles = async (
  fixtureRoot: string,
  files: Readonly<Record<string, string>>,
): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([path, source]) => {
      const target = join(fixtureRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source);
    }),
  );
};

const declarationReferences = (source: string): readonly string[] =>
  [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );

const declarationTarget = (from: string, specifier: string): string => {
  const target = join(dirname(from), specifier);
  if (target.endsWith('.js')) return `${target.slice(0, -3)}.d.ts`;
  if (target.endsWith('.d.ts')) return target;
  return `${target}.d.ts`;
};

const readReachableDeclarations = (entry: string): string => {
  const pending = [entry];
  const visited = new Set<string>();
  const declarations: string[] = [];

  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);

    const source = readFileSync(path, 'utf8');
    declarations.push(`// ${relative(root, path)}\n${source}`);
    pending.push(
      ...declarationReferences(source).map((specifier) => declarationTarget(path, specifier)),
    );
  }

  return declarations.join('\n');
};

const positiveGraph: readonly SourceModule[] = [
  {
    path: 'src/spec/json-value.ts',
    source:
      'export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };\n',
  },
  {
    path: 'src/spec/run-input.ts',
    source: 'export interface RunInput { readonly runId: string }\n',
  },
  {
    path: 'src/spec/run-execution-plan-document.ts',
    source:
      "import type { JsonValue } from './json-value.js';\nexport interface RunExecutionPlanDocument { readonly compiledPipeline: JsonValue }\n",
  },
  {
    path: 'src/spec/index.ts',
    source:
      "export type { JsonValue } from './json-value.js';\nexport type { RunExecutionPlanDocument } from './run-execution-plan-document.js';\nexport type { RunInput } from './run-input.js';\n",
  },
  {
    path: 'src/policy/retry-limit.ts',
    source:
      "import type { RunInput } from '../spec/index.js';\nexport const retryLimit = (_input: RunInput): number => 3;\n",
  },
  {
    path: 'src/policy/index.ts',
    source: "export { retryLimit } from './retry-limit.js';\n",
  },
  {
    path: 'src/errors/run-fault.ts',
    source:
      "import type { RunInput } from '../spec/index.js';\nexport interface RunFault { readonly input: RunInput; readonly code: string }\n",
  },
  {
    path: 'src/errors/index.ts',
    source: "export type { RunFault } from './run-fault.js';\n",
  },
  {
    path: 'src/domain/run-state.ts',
    source:
      "import type { RunInput } from '../spec/index.js';\nexport interface RunState { readonly input: RunInput; readonly revision: number }\n",
  },
  {
    path: 'src/domain/advance-run.ts',
    source:
      "import { retryLimit } from '../policy/index.js';\nimport type { RunInput } from '../spec/index.js';\nexport const advanceRun = (input: RunInput): number => retryLimit(input);\n",
  },
  {
    path: 'src/domain/index.ts',
    source:
      "export { advanceRun } from './advance-run.js';\nexport type { RunState } from './run-state.js';\n",
  },
  {
    path: 'src/storage/run-store-port.ts',
    source:
      "import type { RunState } from '../domain/index.js';\nexport interface RunStorePort { load(): Promise<RunState> }\n",
  },
  {
    path: 'src/storage/index.ts',
    source: "export type { RunStorePort } from './run-store-port.js';\n",
  },
  {
    path: 'src/ports/execution-plan-source.ts',
    source:
      "import type { RunExecutionPlanDocument, RunInput } from '../spec/index.js';\nexport interface ExecutionPlanSource { loadExact(input: RunInput): RunExecutionPlanDocument }\n",
  },
  {
    path: 'src/ports/index.ts',
    source: "export type { ExecutionPlanSource } from './execution-plan-source.js';\n",
  },
  {
    path: 'src/lifecycle/pipeline/decode-plan.ts',
    source:
      "import { decodePipeline } from '@revisium/revo-pipeline';\nimport type { RunExecutionPlanDocument } from '../../spec/index.js';\nexport const decodePlan = (plan: RunExecutionPlanDocument): void => { decodePipeline(plan.compiledPipeline); };\n",
  },
  {
    path: 'src/lifecycle/advance-lifecycle.ts',
    source:
      "import { advanceRun } from '../domain/index.js';\nimport type { ExecutionPlanSource } from '../ports/index.js';\nimport type { RunInput } from '../spec/index.js';\nimport type { RunStorePort } from '../storage/index.js';\nimport { decodePlan } from './pipeline/decode-plan.js';\nexport const advanceLifecycle = (input: RunInput, _store: RunStorePort, plans: ExecutionPlanSource): number => { decodePlan(plans.loadExact(input)); return advanceRun(input); };\n",
  },
  {
    path: 'src/lifecycle/run-lifecycle.ts',
    source:
      "import type { RunInput } from '../spec/index.js';\nexport interface RunLifecycle { advance(input: RunInput): number }\n",
  },
  {
    path: 'src/lifecycle/index.ts',
    source:
      "export { advanceLifecycle } from './advance-lifecycle.js';\nexport type { RunLifecycle } from './run-lifecycle.js';\n",
  },
  {
    path: 'src/manager/build-run-manager.ts',
    source:
      "import type { RunLifecycle } from '../lifecycle/index.js';\nimport type { ExecutionPlanSource } from '../ports/index.js';\nimport type { RunInput } from '../spec/index.js';\nexport const buildRunManager = (lifecycle: RunLifecycle, _plans: ExecutionPlanSource, input: RunInput): number => lifecycle.advance(input);\n",
  },
  {
    path: 'src/manager/index.ts',
    source: "export { buildRunManager } from './build-run-manager.js';\n",
  },
  {
    path: 'src/composition/create-run-manager.ts',
    source:
      "import { advanceLifecycle, type RunLifecycle } from '../lifecycle/index.js';\nimport { buildRunManager } from '../manager/index.js';\nimport type { ExecutionPlanSource } from '../ports/index.js';\nimport type { RunInput } from '../spec/index.js';\nimport type { RunStorePort } from '../storage/index.js';\nexport const createRunManager = (input: RunInput, store: RunStorePort, plans: ExecutionPlanSource): number => { const lifecycle: RunLifecycle = { advance: (value) => advanceLifecycle(value, store, plans) }; return buildRunManager(lifecycle, plans, input); };\n",
  },
  {
    path: 'src/composition/index.ts',
    source: "export { createRunManager } from './create-run-manager.js';\n",
  },
  {
    path: 'src/index.ts',
    source: "export { createRunManager } from './composition/index.js';\n",
  },
];

validateModuleStructure([
  ...(await collectTypeScriptModules(join(root, 'src'))),
  ...(await collectTypeScriptModules(join(root, 'test'))),
]);
validateModuleStructure(positiveGraph);

execFileSync(
  join(root, 'node_modules/.bin/oxlint'),
  ['--config', '.oxlintrc.architecture.json', '--deny-warnings', 'src'],
  { cwd: root, stdio: 'pipe' },
);

const probes: readonly (readonly [ArchitectureRule, readonly SourceModule[]])[] = [
  [
    'type-cycle',
    [
      {
        path: 'src/storage/first-port.ts',
        source:
          "import type { SecondPort } from './second-port.js';\nexport interface FirstPort { readonly second: SecondPort }\n",
      },
      {
        path: 'src/storage/second-port.ts',
        source:
          "import type { FirstPort } from './first-port.js';\nexport interface SecondPort { readonly first: FirstPort }\n",
      },
    ],
  ],
  [
    'relative-js-suffix',
    [
      {
        path: 'src/domain/run-state.ts',
        source:
          "import type { RunInput } from '../spec/index';\nexport interface RunState { readonly input: RunInput }\n",
      },
    ],
  ],
  [
    'private-import',
    [
      {
        path: 'src/lifecycle/advance.ts',
        source:
          "import type { RunState } from '../domain/run-state.js';\nexport const advance = (_state: RunState): void => undefined;\n",
      },
    ],
  ],
  [
    'external-import',
    [
      {
        path: 'src/domain/prisma-run.ts',
        source:
          "import type { PrismaClient } from '@prisma/client';\nexport const usePrisma = (_client: PrismaClient): void => undefined;\n",
      },
    ],
  ],
  [
    'external-import',
    [
      {
        path: 'src/lifecycle/decode.ts',
        source:
          "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport interface LifecyclePipeline { readonly pipeline: CompiledPipeline }\n",
      },
    ],
  ],
  [
    'pipeline-facade-import',
    [
      {
        path: 'src/lifecycle/index.ts',
        source: "export { decodePlan } from './pipeline/decode-plan.js';\n",
      },
    ],
  ],
  [
    'external-import',
    [
      {
        path: 'src/manager/pipeline.ts',
        source:
          "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport interface ManagerPipeline { readonly pipeline: CompiledPipeline }\n",
      },
    ],
  ],
  [
    'external-import',
    [
      {
        path: 'src/ports/pipeline-port.ts',
        source:
          "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport interface PipelinePort { readonly pipeline: CompiledPipeline }\n",
      },
    ],
  ],
  [
    'forbidden-mcp-import',
    [
      {
        path: 'src/lifecycle/mcp.ts',
        source:
          "import type { Server } from '@modelcontextprotocol/sdk/server/index.js';\nexport const useServer = (_server: Server): void => undefined;\n",
      },
    ],
  ],
  [
    'forbidden-orchestrator-import',
    [
      {
        path: 'src/lifecycle/orchestrator.ts',
        source:
          "import type { Orchestrator } from '@revisium/orchestrator';\nexport const useOrchestrator = (_orchestrator: Orchestrator): void => undefined;\n",
      },
    ],
  ],
  [
    'forbidden-executor-runtime-import',
    [
      {
        path: 'src/manager/agent-runtime.ts',
        source:
          "import type { AgentRuntime } from '@revisium/revo-agent-runtime';\nexport const useRuntime = (_runtime: AgentRuntime): void => undefined;\n",
      },
    ],
  ],
  [
    'forbidden-executor-runtime-import',
    [
      {
        path: 'src/manager/scripts-runtime.ts',
        source:
          "import type { RevoScripts } from '@revisium/revo-scripts';\nexport const useScripts = (_scripts: RevoScripts): void => undefined;\n",
      },
    ],
  ],
  [
    'forbidden-production-import',
    [
      {
        path: 'src/domain/test-helper.ts',
        source:
          "import { helper } from '../../test/helper.js';\nexport const testHelper = helper;\n",
      },
    ],
  ],
  [
    'forbidden-layer-import',
    [
      {
        path: 'src/domain/host-loop.ts',
        source:
          "import { poll } from '../lifecycle/index.js';\nexport const hostLoop = (): void => poll();\n",
      },
    ],
  ],
  [
    'private-import',
    [
      {
        path: 'src/manager/private-lifecycle.ts',
        source:
          "import { advanceLifecycle } from '../lifecycle/advance-lifecycle.js';\nexport const managerAdvance = (): typeof advanceLifecycle => advanceLifecycle;\n",
      },
    ],
  ],
  [
    'manager-boundary-inference',
    [
      {
        path: 'src/manager/inferred-lifecycle.ts',
        source:
          "import type { RunLifecycle } from '../lifecycle/index.js';\nexport type ManagerStart = ReturnType<RunLifecycle['advance']>;\n",
      },
    ],
  ],
  [
    'manager-boundary-inference',
    [
      {
        path: 'src/manager/inferred-parameters.ts',
        source:
          "import type { RunLifecycle } from '../lifecycle/index.js';\nexport type ManagerInput = Parameters<RunLifecycle['advance']>[0];\n",
      },
    ],
  ],
  [
    'forbidden-layer-import',
    [
      {
        path: 'src/manager/store.ts',
        source:
          "import type { RunStorePort } from '../storage/index.js';\nexport interface ManagerStore { readonly store: RunStorePort }\n",
      },
    ],
  ],
  [
    'forbidden-layer-import',
    [
      {
        path: 'src/manager/domain.ts',
        source:
          "import { advanceRun } from '../domain/index.js';\nexport const managerAdvance = (): typeof advanceRun => advanceRun;\n",
      },
    ],
  ],
  [
    'forbidden-layer-import',
    [
      {
        path: 'src/composition/domain.ts',
        source:
          "import { advanceRun } from '../domain/index.js';\nexport const composeDomain = (): typeof advanceRun => advanceRun;\n",
      },
    ],
  ],
  [
    'forbidden-layer-import',
    [
      {
        path: 'src/composition/policy.ts',
        source:
          "import { retryLimit } from '../policy/index.js';\nexport const composePolicy = (): typeof retryLimit => retryLimit;\n",
      },
    ],
  ],
  [
    'external-import',
    [
      {
        path: 'src/composition/pipeline.ts',
        source:
          "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport interface CompositionPipeline { readonly pipeline: CompiledPipeline }\n",
      },
    ],
  ],
  [
    'forbidden-layer-import',
    [
      {
        path: 'src/index.ts',
        source: "export { buildRunManager } from './manager/index.js';\n",
      },
    ],
  ],
  [
    'type-only-layer',
    [
      {
        path: 'src/storage/default-store.ts',
        source: 'export const defaultStore = {};\n',
      },
    ],
  ],
  [
    'type-only-layer',
    [
      {
        path: 'src/ports/runtime-executor.ts',
        source: 'export const runtimeExecutor = {};\n',
      },
    ],
  ],
  [
    'one-export-per-leaf',
    [
      {
        path: 'src/domain/multiple.ts',
        source: 'export const first = 1;\nexport const second = 2;\n',
      },
    ],
  ],
  [
    'explicit-barrel-exports',
    [
      {
        path: 'src/domain/index.ts',
        source: "export * from './run-state.js';\n",
      },
    ],
  ],
  [
    'own-barrel-import',
    [
      {
        path: 'src/domain/run-state.ts',
        source:
          "import type { OtherState } from './index.js';\nexport interface RunState { readonly other: OtherState }\n",
      },
    ],
  ],
  [
    'unknown-layer',
    [
      {
        path: 'src/custom/extension.ts',
        source: 'export const extension = (): void => undefined;\n',
      },
    ],
  ],
  [
    'test-private-import',
    [
      {
        path: 'test/unit/domain/run.test.ts',
        source:
          "import type { RunState } from '../../../src/domain/run-state.js';\nexport type TestedState = RunState;\n",
      },
    ],
  ],
];

for (const [rule, modules] of probes) expectRuleFailure(modules, rule);

const declarationProbeRoot = await mkdtemp(join(root, '.declaration-probe-'));
try {
  const commonFiles = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: 'src',
        outDir: 'dist',
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
    'src/pipeline-marker.d.ts':
      "declare module '@revisium/revo-pipeline' {\n  export interface PipelineDeclarationMarker { readonly __pipelineMarker: 'pipeline' }\n}\n",
    'src/manager/index.ts':
      "import type { RunLifecycle } from '../lifecycle/index.js';\nexport interface RunManager { readonly lifecycle: RunLifecycle }\n",
    'src/composition/index.ts':
      "import type { RunManager } from '../manager/index.js';\nexport declare function createRunManager(): RunManager;\n",
    'src/index.ts':
      "export { createRunManager } from './composition/index.js';\nexport type { RunManager } from './manager/index.js';\n",
  } as const;

  const positiveRoot = join(declarationProbeRoot, 'positive');
  await writeFixtureFiles(positiveRoot, {
    ...commonFiles,
    'src/lifecycle/index.ts':
      'export interface RunLifecycle { start(runId: string): Promise<void> }\n',
    'src/lifecycle/pipeline/private-decoded.ts':
      "import type { PipelineDeclarationMarker } from '@revisium/revo-pipeline';\nexport interface PrivateDecoded { readonly pipeline: PipelineDeclarationMarker }\n",
  });

  const negativeRoot = join(declarationProbeRoot, 'negative');
  await writeFixtureFiles(negativeRoot, {
    ...commonFiles,
    'src/lifecycle/index.ts':
      "import type { PipelineDeclarationMarker } from '@revisium/revo-pipeline';\nexport interface RunLifecycle { readonly pipeline: PipelineDeclarationMarker; start(runId: string): Promise<void> }\n",
  });

  for (const fixtureRoot of [positiveRoot, negativeRoot]) {
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
      cwd: fixtureRoot,
      stdio: 'pipe',
    });
  }

  const marker = /@revisium\/revo-pipeline|PipelineDeclarationMarker/;
  const positiveDeclarations = readReachableDeclarations(join(positiveRoot, 'dist/index.d.ts'));
  assert.doesNotMatch(
    positiveDeclarations,
    marker,
    'Pipeline marker must not leak into declarations reachable from the positive root',
  );

  const negativeDeclarations = readReachableDeclarations(join(negativeRoot, 'dist/index.d.ts'));
  assert.match(
    negativeDeclarations,
    marker,
    'Reachable declaration scan must detect a transitive pipeline leak',
  );
} finally {
  await rm(declarationProbeRoot, { recursive: true, force: true });
}

const temporaryRoot = await mkdtemp(join(root, '.architecture-probe-'));
try {
  const lintProbes = [
    {
      name: 'tooling/generated',
      path: 'src/lifecycle/generated-tooling-probe.ts',
      source:
        "import { generatedHelper } from '../../scripts/generated-helper.js';\nexport const probe = generatedHelper;\n",
      expectedMessage:
        'Production source must not depend on tests, repository tooling, generated output, or architecture probes.',
    },
    {
      name: 'Prisma',
      path: 'src/domain/prisma-probe.ts',
      source:
        "import type { PrismaClient } from '@prisma/client';\nexport const probe = (_client: PrismaClient): void => undefined;\n",
      expectedMessage:
        'Database frameworks, worker runtimes, queues, and API transports are outside revo-run.',
    },
    {
      name: 'MCP',
      path: 'src/lifecycle/mcp-probe.ts',
      source:
        "import type { Server } from '@modelcontextprotocol/sdk/server/index.js';\nexport const probe = (_server: Server): void => undefined;\n",
      expectedMessage: 'MCP transport and server dependencies belong to the host, not revo-run.',
    },
    {
      name: 'orchestrator',
      path: 'src/lifecycle/orchestrator-probe.ts',
      source:
        "import type { Orchestrator } from '@revisium/orchestrator';\nexport const probe = (_orchestrator: Orchestrator): void => undefined;\n",
      expectedMessage:
        'Orchestrator packages are hosts of revo-run and must never be dependencies.',
    },
    {
      name: 'agent runtime',
      path: 'src/manager/agent-runtime-probe.ts',
      source:
        "import type { AgentRuntime } from '@revisium/revo-agent-runtime';\nexport const probe = (_runtime: AgentRuntime): void => undefined;\n",
      expectedMessage:
        'Agent and script runtimes belong behind injected executor adapters, not in revo-run core.',
    },
    {
      name: 'scripts runtime',
      path: 'src/manager/scripts-probe.ts',
      source:
        "import type { RevoScripts } from '@revisium/revo-scripts';\nexport const probe = (_scripts: RevoScripts): void => undefined;\n",
      expectedMessage:
        'Agent and script runtimes belong behind injected executor adapters, not in revo-run core.',
    },
    {
      name: 'manager pipeline',
      path: 'src/manager/pipeline-probe.ts',
      source:
        "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport const probe = (_pipeline: CompiledPipeline): void => undefined;\n",
      expectedMessage:
        'Only private revo-run lifecycle/pipeline modules may import the public pipeline package.',
    },
  ] as const;

  await Promise.all(
    lintProbes.map(async (probe) => {
      const fixture = join(temporaryRoot, probe.path);
      await mkdir(dirname(fixture), { recursive: true });
      await writeFile(fixture, probe.source);

      const lintProbe = spawnSync(
        join(root, 'node_modules/.bin/oxlint'),
        [
          '--config',
          '.oxlintrc.architecture.json',
          '--deny-warnings',
          '--format',
          'json',
          relative(root, fixture).replaceAll('\\', '/'),
        ],
        { cwd: root, encoding: 'utf8' },
      );
      assert.notEqual(lintProbe.status, 0, `${probe.name} Oxc negative probe must fail`);
      const lintOutput: unknown = JSON.parse(lintProbe.stdout);
      assert.ok(isRecord(lintOutput), `${probe.name} Oxc output must be an object`);
      assert.ok(
        Array.isArray(lintOutput.diagnostics),
        `${probe.name} Oxc output must contain diagnostics`,
      );
      assert.equal(
        lintOutput.diagnostics.length,
        1,
        `${probe.name} fixture must match exactly one configured restriction`,
      );
      const diagnostic: unknown = lintOutput.diagnostics[0];
      assert.ok(isRecord(diagnostic), `${probe.name} Oxc diagnostic must be an object`);
      assert.equal(diagnostic.code, 'eslint(no-restricted-imports)');
      assert.equal(diagnostic.help, probe.expectedMessage);
    }),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const remainingEntries = await readdir(root);
assert.equal(
  remainingEntries.some(
    (entry) => entry.startsWith('.architecture-probe-') || entry.startsWith('.declaration-probe-'),
  ),
  false,
  'Architecture and declaration probes must be removed after validation',
);

console.log(
  'Architecture validation passed (real graph, nine-layer positive graph, exact, declaration, and Oxc negative probes, cleanup).',
);
