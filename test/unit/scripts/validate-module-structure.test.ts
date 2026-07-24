import { expect, test } from 'vitest';

import {
  validateModuleStructure,
  type ArchitectureRule,
  type SourceModule,
} from '../../../scripts/architecture/validate-module-structure.js';

const expectViolation = (
  modules: readonly SourceModule[],
  expectedRule: ArchitectureRule,
): void => {
  expect(() => validateModuleStructure(modules)).toThrowError(`[${expectedRule}]`);
};

test('accepts the intended layer dependency direction', () => {
  expect(() =>
    validateModuleStructure([
      {
        path: 'src/spec/run-input.ts',
        source: 'export interface RunInput { readonly id: string }\n',
      },
      {
        path: 'src/spec/index.ts',
        source: "export type { RunInput } from './run-input.js';\n",
      },
      {
        path: 'src/domain/create-run.ts',
        source:
          "import type { RunInput } from '../spec/index.js';\nexport const createRun = (input: RunInput): RunInput => input;\n",
      },
      {
        path: 'src/domain/index.ts',
        source: "export { createRun } from './create-run.js';\n",
      },
      {
        path: 'src/storage/run-store.ts',
        source:
          "import type { createRun } from '../domain/index.js';\nexport interface RunStore { save(value: ReturnType<typeof createRun>): Promise<void> }\n",
      },
    ]),
  ).not.toThrow();
});

test('detects cycles made only from type imports', () => {
  expect.hasAssertions();
  expectViolation(
    [
      {
        path: 'src/storage/a.ts',
        source: "import type { B } from './b.js';\nexport interface A { readonly dependency: B }\n",
      },
      {
        path: 'src/storage/b.ts',
        source: "import type { A } from './a.js';\nexport interface B { readonly dependency: A }\n",
      },
    ],
    'type-cycle',
  );
});

test.each([
  [
    'relative-js-suffix',
    'src/domain/run.ts',
    "import type { Input } from '../spec/index';\nexport interface Run { readonly input: Input }\n",
  ],
  [
    'private-import',
    'src/lifecycle/run.ts',
    "import type { RunState } from '../domain/run-state.js';\nexport const run = (_state: RunState): void => undefined;\n",
  ],
  [
    'external-import',
    'src/domain/run.ts',
    "import type { PrismaClient } from '@prisma/client';\nexport const run = (_client: PrismaClient): void => undefined;\n",
  ],
  [
    'forbidden-mcp-import',
    'src/lifecycle/mcp.ts',
    "import type { Server } from '@modelcontextprotocol/sdk/server/index.js';\nexport const useMcp = (_server: Server): void => undefined;\n",
  ],
  [
    'forbidden-orchestrator-import',
    'src/lifecycle/orchestrator.ts',
    "import type { Orchestrator } from '@revisium/orchestrator';\nexport const useOrchestrator = (_orchestrator: Orchestrator): void => undefined;\n",
  ],
  [
    'forbidden-production-import',
    'src/domain/test-helper.ts',
    "import { helper } from '../../test/helper.js';\nexport const testHelper = helper;\n",
  ],
  [
    'forbidden-layer-import',
    'src/domain/run.ts',
    "import { execute } from '../lifecycle/index.js';\nexport const run = (): void => execute();\n",
  ],
  ['type-only-layer', 'src/storage/store.ts', 'export const store = {};\n'],
  [
    'one-export-per-leaf',
    'src/domain/multiple.ts',
    'export const first = 1;\nexport const second = 2;\n',
  ],
  ['explicit-barrel-exports', 'src/domain/index.ts', "export * from './run-state.js';\n"],
  [
    'own-barrel-import',
    'src/domain/run.ts',
    "import type { State } from './index.js';\nexport interface Run { readonly state: State }\n",
  ],
  ['unknown-layer', 'src/worker/poll.ts', 'export const poll = (): void => undefined;\n'],
  [
    'test-private-import',
    'test/unit/domain/run.test.ts',
    "import type { RunState } from '../../../src/domain/run-state.js';\nexport type TestedState = RunState;\n",
  ],
] as const)('rejects %s violations', (rule, path, source) => {
  expect.hasAssertions();
  expectViolation([{ path, source }], rule);
});

test('allows tests to import the root and curated layer barrels', () => {
  expect(() =>
    validateModuleStructure([
      {
        path: 'test/unit/domain/run.test.ts',
        source:
          "import * as packageEntry from '../../../src/index.js';\nimport type { RunState } from '../../../src/domain/index.js';\nvoid packageEntry;\nexport type TestedState = RunState;\n",
      },
    ]),
  ).not.toThrow();
});

test.each([
  '../../test/helper.js',
  '../../scripts/helper.js',
  '../../dist/helper.js',
  '../../coverage/helper.js',
  '../../.architecture-probe-fixture/helper.js',
])('rejects production imports from repository-only target %s', (specifier) => {
  expect.hasAssertions();
  expectViolation(
    [
      {
        path: 'src/domain/run.ts',
        source: `import { helper } from '${specifier}';\nexport const run = helper;\n`,
      },
    ],
    'forbidden-production-import',
  );
});

test.each(['@revisium/revo-pipeline', '@revisium/revo-agent-runtime'])(
  'rejects forbidden package import %s from every production layer',
  (packageName) => {
    expect.hasAssertions();
    expectViolation(
      [
        {
          path: 'src/lifecycle/compile.ts',
          source: `import type { ImportedContract } from '${packageName}';\nexport const compile = (value: ImportedContract): ImportedContract => value;\n`,
        },
      ],
      'external-import',
    );
  },
);

test('requires the root entrypoint to use curated layer barrels', () => {
  expect.hasAssertions();
  expectViolation(
    [
      {
        path: 'src/index.ts',
        source: "export { startRun } from './lifecycle/start-run.js';\n",
      },
    ],
    'private-import',
  );
});

test.each([
  'export const { first, nested: { second } } = source;\n',
  'export const [first, , second] = source;\n',
])('counts every exported name in a destructured binding', (source) => {
  expect.hasAssertions();
  expectViolation([{ path: 'src/domain/destructured.ts', source }], 'one-export-per-leaf');
});

test('requires type-only syntax in type-only barrels and leaves', () => {
  expect.hasAssertions();
  expectViolation(
    [
      {
        path: 'src/spec/index.ts',
        source: "export { RunInput } from './run-input.js';\n",
      },
    ],
    'type-only-layer',
  );
  expectViolation(
    [
      {
        path: 'src/storage/run-store.ts',
        source:
          "import { RunState } from '../domain/index.js';\nexport interface RunStore { readonly state: RunState }\n",
      },
    ],
    'type-only-layer',
  );
  expectViolation(
    [
      {
        path: 'src/storage/run-store.ts',
        source:
          "import RunState = require('../domain/index.js');\nexport interface RunStore { readonly state: RunState }\n",
      },
    ],
    'type-only-layer',
  );
});

test('recognizes import-equals, dynamic-import, and import-type references', () => {
  expect(() =>
    validateModuleStructure([
      {
        path: 'src/storage/import-equals.ts',
        source:
          "import type Other = require('./other.js');\nexport interface Store { readonly other: Other }\n",
      },
      {
        path: 'src/domain/dynamic.ts',
        source: "export const load = () => import('./other.js');\n",
      },
      {
        path: 'src/storage/import-type.ts',
        source: "export type Store = import('./other.js').Other;\n",
      },
    ]),
  ).not.toThrow();

  expectViolation(
    [
      {
        path: 'src/domain/dynamic.ts',
        source: "const target = './other.js';\nexport const load = () => import(target);\n",
      },
    ],
    'relative-js-suffix',
  );
});

test.each([
  'const local = 1;\nexport const value = local;\n',
  "export { value } from './other.js';\n",
  'export default 1;\n',
  'export class Value {}\n',
  'export enum Value { One }\n',
  'export function value(): void {}\n',
  'export type Value = string;\n',
])('accepts one exported production entity across supported syntax', (source) => {
  expect(() => validateModuleStructure([{ path: 'src/domain/value.ts', source }])).not.toThrow();
});
