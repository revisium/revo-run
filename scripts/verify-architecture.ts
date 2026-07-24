import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import {
  validateModuleStructure,
  type ArchitectureRule,
  type SourceModule,
} from './architecture/validate-module-structure.js';

const root = process.cwd();

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

const positiveGraph: readonly SourceModule[] = [
  {
    path: 'src/spec/run-input.ts',
    source: 'export interface RunInput { readonly runId: string }\n',
  },
  {
    path: 'src/spec/index.ts',
    source: "export type { RunInput } from './run-input.js';\n",
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
        path: 'src/lifecycle/agent-runtime.ts',
        source:
          "import type { AgentRuntime } from '@revisium/revo-agent-runtime';\nexport const runtime = (_value: AgentRuntime): void => undefined;\n",
      },
    ],
  ],
  [
    'external-import',
    [
      {
        path: 'src/lifecycle/pipeline.ts',
        source:
          "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport const pipeline = (_value: CompiledPipeline): void => undefined;\n",
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
    'type-only-layer',
    [
      {
        path: 'src/storage/default-store.ts',
        source: 'export const defaultStore = {};\n',
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
        path: 'src/worker/poll.ts',
        source: 'export const poll = (): void => undefined;\n',
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

const temporaryRoot = await mkdtemp(join(root, '.architecture-probe-'));
try {
  const fixture = join(temporaryRoot, 'src/domain/probe.ts');
  await mkdir(dirname(fixture), { recursive: true });
  await writeFile(
    fixture,
    "import type { PrismaClient } from '@prisma/client';\nexport const probe = (_client: PrismaClient): void => undefined;\n",
  );
  expectRuleFailure(
    await collectTypeScriptModules(join(temporaryRoot, 'src'), temporaryRoot),
    'external-import',
  );
  const lintProbe = spawnSync(
    join(root, 'node_modules/.bin/oxlint'),
    [
      '--config',
      '.oxlintrc.architecture.json',
      '--deny-warnings',
      relative(root, fixture).replaceAll('\\', '/'),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(lintProbe.status, 0, 'The negative architecture lint probe must fail');
  assert.match(
    `${lintProbe.stdout}${lintProbe.stderr}`,
    /no-restricted-imports/,
    'The negative architecture lint probe must fail through no-restricted-imports',
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const remainingEntries = await readdir(root);
assert.equal(
  remainingEntries.some((entry) => entry.startsWith('.architecture-probe-')),
  false,
  'Architecture probes must be removed after validation',
);

console.log(
  'Architecture validation passed (real graph, positive graph, exact negative rules, cleanup).',
);
