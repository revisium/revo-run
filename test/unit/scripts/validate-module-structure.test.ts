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
        path: 'src/spec/json-value.ts',
        source:
          'export type JsonValue = null | boolean | number | string | readonly JsonValue[];\n',
      },
      {
        path: 'src/spec/run-input.ts',
        source: 'export interface RunInput { readonly id: string }\n',
      },
      {
        path: 'src/spec/plan-document.ts',
        source:
          "import type { JsonValue } from './json-value.js';\nexport interface PlanDocument { readonly compiledPipeline: JsonValue }\n",
      },
      {
        path: 'src/spec/index.ts',
        source:
          "export type { JsonValue } from './json-value.js';\nexport type { PlanDocument } from './plan-document.js';\nexport type { RunInput } from './run-input.js';\n",
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
      {
        path: 'src/ports/plan-source.ts',
        source:
          "import type { PlanDocument, RunInput } from '../spec/index.js';\nexport interface PlanSource { loadExact(input: RunInput): PlanDocument }\n",
      },
      {
        path: 'src/lifecycle/pipeline/decode.ts',
        source:
          "import { decodePipeline } from '@revisium/revo-pipeline';\nimport type { PlanDocument } from '../../spec/index.js';\nexport const decode = (plan: PlanDocument): void => { decodePipeline(plan.compiledPipeline); };\n",
      },
      {
        path: 'src/lifecycle/start-run.ts',
        source:
          "import { createRun } from '../domain/index.js';\nimport type { PlanSource } from '../ports/index.js';\nimport type { RunInput } from '../spec/index.js';\nimport type { RunStore } from '../storage/index.js';\nimport { decode } from './pipeline/decode.js';\nexport const startRun = (input: RunInput, plans: PlanSource, _store: RunStore): RunInput => { decode(plans.loadExact(input)); return createRun(input); };\n",
      },
      {
        path: 'src/lifecycle/run-lifecycle.ts',
        source:
          "import type { RunInput } from '../spec/index.js';\nexport interface RunLifecycle { start(input: RunInput): RunInput }\n",
      },
      {
        path: 'src/manager/create-manager.ts',
        source:
          "import type { RunLifecycle } from '../lifecycle/index.js';\nimport type { PlanSource } from '../ports/index.js';\nexport const createManager = (lifecycle: RunLifecycle, _plans: PlanSource): RunLifecycle => lifecycle;\n",
      },
      {
        path: 'src/composition/create.ts',
        source:
          "import { startRun, type RunLifecycle } from '../lifecycle/index.js';\nimport { createManager } from '../manager/index.js';\nimport type { PlanSource } from '../ports/index.js';\nimport type { RunStore } from '../storage/index.js';\nexport const create = (store: RunStore, plans: PlanSource): RunLifecycle => createManager({ start: (input) => startRun(input, plans, store) }, plans);\n",
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
    'forbidden-executor-runtime-import',
    'src/manager/agent-runtime.ts',
    "import type { AgentRuntime } from '@revisium/revo-agent-runtime';\nexport const useRuntime = (_runtime: AgentRuntime): void => undefined;\n",
  ],
  [
    'forbidden-executor-runtime-import',
    'src/manager/scripts-runtime.ts',
    "import type { RevoScripts } from '@revisium/revo-scripts';\nexport const useScripts = (_scripts: RevoScripts): void => undefined;\n",
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
  [
    'forbidden-layer-import',
    'src/manager/store.ts',
    "import type { RunStore } from '../storage/index.js';\nexport interface ManagerStore { readonly store: RunStore }\n",
  ],
  [
    'forbidden-layer-import',
    'src/manager/domain.ts',
    "import { createRun } from '../domain/index.js';\nexport const managerRun = (): typeof createRun => createRun;\n",
  ],
  [
    'forbidden-layer-import',
    'src/composition/domain.ts',
    "import { createRun } from '../domain/index.js';\nexport const composedRun = (): typeof createRun => createRun;\n",
  ],
  [
    'forbidden-layer-import',
    'src/composition/policy.ts',
    "import { retryLimit } from '../policy/index.js';\nexport const composedPolicy = (): typeof retryLimit => retryLimit;\n",
  ],
  [
    'external-import',
    'src/composition/pipeline.ts',
    "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport interface CompositionPipeline { readonly pipeline: CompiledPipeline }\n",
  ],
  [
    'private-import',
    'src/manager/private-lifecycle.ts',
    "import { startRun } from '../lifecycle/start-run.js';\nexport const managerStart = (): typeof startRun => startRun;\n",
  ],
  [
    'manager-boundary-inference',
    'src/manager/inferred-lifecycle.ts',
    "import type { RunLifecycle } from '../lifecycle/index.js';\nexport type ManagerStart = ReturnType<RunLifecycle['start']>;\n",
  ],
  [
    'manager-boundary-inference',
    'src/manager/inferred-parameters.ts',
    "import type { RunLifecycle } from '../lifecycle/index.js';\nexport type ManagerInput = Parameters<RunLifecycle['start']>[0];\n",
  ],
  [
    'pipeline-facade-import',
    'src/lifecycle/index.ts',
    "export { decode } from './pipeline/decode.js';\n",
  ],
  [
    'external-import',
    'src/lifecycle/decode.ts',
    "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport interface LifecyclePipeline { readonly pipeline: CompiledPipeline }\n",
  ],
  [
    'external-import',
    'src/ports/pipeline.ts',
    "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport interface PipelinePort { readonly pipeline: CompiledPipeline }\n",
  ],
  ['type-only-layer', 'src/storage/store.ts', 'export const store = {};\n'],
  ['type-only-layer', 'src/ports/runtime.ts', 'export const runtime = {};\n'],
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
  ['unknown-layer', 'src/custom/extension.ts', 'export const extension = (): void => undefined;\n'],
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

test('allows only the pipeline package and only from private lifecycle pipeline modules', () => {
  expect(() =>
    validateModuleStructure([
      {
        path: 'src/lifecycle/pipeline/compile.ts',
        source:
          "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport const compile = (pipeline: CompiledPipeline): CompiledPipeline => pipeline;\n",
      },
    ]),
  ).not.toThrow();

  expectViolation(
    [
      {
        path: 'src/domain/compile.ts',
        source:
          "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport const compile = (pipeline: CompiledPipeline): CompiledPipeline => pipeline;\n",
      },
    ],
    'external-import',
  );

  expectViolation(
    [
      {
        path: 'src/lifecycle/compile.ts',
        source:
          "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport const compile = (pipeline: CompiledPipeline): CompiledPipeline => pipeline;\n",
      },
    ],
    'external-import',
  );

  expectViolation(
    [
      {
        path: 'src/manager/compile.ts',
        source:
          "import type { CompiledPipeline } from '@revisium/revo-pipeline';\nexport const compile = (pipeline: CompiledPipeline): CompiledPipeline => pipeline;\n",
      },
    ],
    'external-import',
  );
});

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

  expectViolation(
    [
      {
        path: 'src/index.ts',
        source: "export { buildRunManager } from './manager/index.js';\n",
      },
    ],
    'forbidden-layer-import',
  );

  expect(() =>
    validateModuleStructure([
      {
        path: 'src/index.ts',
        source:
          "export { createRunManager } from './composition/index.js';\nexport type { RunInput } from './spec/index.js';\n",
      },
    ]),
  ).not.toThrow();
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
        path: 'src/ports/executor.ts',
        source: 'export const executor = {};\n',
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
