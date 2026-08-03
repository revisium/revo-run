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
  for (const source of [
    'const hostile = 1;\ntype T = typeof hostile;\nexport function create<T>(value: T): T { return value; }\n',
    'const hostile = 1;\ntype T = typeof hostile;\nexport type Create<T> = { readonly value: T };\n',
    'const hostile = 1;\ntype T = typeof hostile;\nexport interface Create<T> { readonly value: T }\n',
    'const hostile = 1;\ntype collision = typeof hostile;\nexport type Create = { readonly collision: string };\n',
    'const hostile = 1;\ntype value = typeof hostile;\nexport type Create = (value: string) => string;\n',
    'const hostile = 1;\ntype T = typeof hostile;\nexport type Create = <T>(value: T) => T;\n',
    'const hostile = 1;\ntype T = typeof hostile;\nexport interface Create { readonly map: <T>(value: T) => T }\n',
    'const hostile = 1;\ntype K = typeof hostile;\nexport type Create<T> = { [K in keyof T]: T[K] };\n',
    'const hostile = 1;\ntype U = typeof hostile;\nexport type Create<T> = T extends Promise<infer U> ? U : T;\n',
    'const hostile = 1;\ntype T = typeof hostile;\nexport type Create<T> = T extends (infer U extends T) ? U : T;\n',
    'const hostile = 1;\ntype T = typeof hostile;\nexport type Create<T> = T extends readonly [infer U extends T, ...unknown[]] ? U : T;\n',
    'const hostile = 1;\ntype X = typeof hostile;\nexport type Create<X> = X extends (infer U extends X) ? U : X;\n',
    'const hostile = 1;\ntype T = typeof hostile;\nexport type Create = new <T>(value: T) => { readonly value: T };\n',
    'const hostile = 1;\ntype label = typeof hostile;\nexport type Create = readonly [label: string];\n',
    'const hostile = 1;\ntype value = typeof hostile;\nexport function create(value: unknown): value is string { return typeof value === "string"; }\n',
    "const hostile = 1;\ntype ExecutorResolver = typeof hostile;\nexport type Create = import('../ports/index.js').ExecutorResolver;\n",
  ]) {
    expect(() =>
      validateModuleStructure([
        {
          path: 'src/lifecycle/construction.ts',
          source: "export type { Create } from './generic-shadow.js';\n",
        },
        { path: 'src/lifecycle/generic-shadow.ts', source },
      ]),
    ).not.toThrow();
  }
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

test('enforces operational and construction reachable declaration boundaries', () => {
  expect.hasAssertions();
  expect(() =>
    validateModuleStructure([
      {
        path: 'src/lifecycle/run-lifecycle.ts',
        source:
          'export interface Safe { readonly ResolvedExecutor: "ResolvedExecutor"; readonly ProviderPayload: "ProviderPayload" }\n// ExecutorResolution is harmless trivia\n',
      },
    ]),
  ).not.toThrow();
  expectViolation(
    [
      {
        path: 'src/lifecycle/index.ts',
        source: "export type { Leak } from './leak.js';\n",
      },
      {
        path: 'src/lifecycle/leak.ts',
        source:
          "import type { RunStore } from '../storage/index.js';\nexport interface Leak { readonly store: RunStore }\n",
      },
    ],
    'lifecycle-port-boundary',
  );
  for (const source of [
    "import type { RunState } from '../domain/index.js';\nexport function create<T extends RunState>(): void {}\n",
    "import type { ExecutionPlanSource } from '../ports/index.js';\nexport function create<T = ExecutionPlanSource>(): void {}\n",
    "import { advanceRun } from '../domain/index.js';\nconst { create } = { create: advanceRun };\nexport { create };\n",
  ]) {
    expectViolation(
      [
        {
          path: 'src/lifecycle/construction.ts',
          source: "export { create } from './generic-or-binding.js';\n",
        },
        { path: 'src/lifecycle/generic-or-binding.ts', source },
      ],
      'lifecycle-port-boundary',
    );
  }
  for (const source of [
    "import { advanceRun } from '../domain/index.js';\nconst hidden = advanceRun;\ntype Hidden = typeof hidden;\nexport interface Create { readonly hidden: Hidden }\n",
    'interface Hidden { (): void }\nexport interface Create { readonly hidden: Hidden }\n',
    'class Hidden {}\nexport interface Create { readonly hidden: Hidden }\n',
    'interface Hidden { readonly ["value"]: number }\nexport interface Create { readonly hidden: Hidden }\n',
    'interface Hidden { run(): void }\nexport const Create: Hidden = {} as Hidden;\n',
    'type Hidden = ({ value }: { value: number }) => void;\nexport interface Create { readonly hidden: Hidden }\n',
    "import type { RunState } from '../domain/index.js';\ntype Hidden<T extends RunState = RunState> = { readonly value: T };\nexport interface Create { readonly hidden: Hidden<RunState> }\n",
    "import type { RunState } from '../domain/index.js';\nexport type Create = <T extends RunState = RunState>(value: T) => T;\n",
    "import type { RunState } from '../domain/index.js';\nexport type Create<T> = { [K in keyof RunState]: T };\n",
    'const hostile = 1;\ntype Alias = typeof hostile;\nexport type Create<T> = T extends (infer U extends Alias) ? U : T;\n',
    "import type { RunState } from '../domain/index.js';\nexport type Create<T> = T extends (infer U extends RunState) ? U : T;\n",
    "import type { RunState } from '../domain/index.js';\nexport type Create<T> = T extends readonly [infer U extends RunState, ...unknown[]] ? U : T;\n",
    "export type Create<T> = T extends (infer U extends import('../domain/index.js').RunState) ? U : T;\n",
    "import type { RunState } from '../domain/index.js';\nexport type Create<T> = T extends (infer U extends { readonly state: RunState }) ? U : T;\n",
    "import type { RunState } from '../domain/index.js';\ndeclare const key: unique symbol;\nexport interface Create { readonly [key]: RunState }\n",
    "import type { RunState, domainKey } from '../domain/index.js';\nexport type Create = { readonly [domainKey]: RunState };\n",
  ]) {
    expectViolation(
      [
        {
          path: 'src/lifecycle/construction.ts',
          source: "export type { Create } from './hidden-public.js';\n",
        },
        { path: 'src/lifecycle/hidden-public.ts', source },
      ],
      'lifecycle-port-boundary',
    );
  }
  for (const source of [
    'export function create() { return undefined; }\n',
    'export const create = () => undefined;\n',
    'export class Create { run() { return undefined; } }\n',
    'export class Create { get value() { return 1; } }\n',
    'export class Create { readonly value = 1; }\n',
    'const local = (): void => undefined;\nexport const create = local;\n',
  ]) {
    expectViolation(
      [
        {
          path: 'src/lifecycle/construction.ts',
          source: "export { create } from './inferred.js';\n",
        },
        { path: 'src/lifecycle/inferred.ts', source },
      ],
      'lifecycle-port-boundary',
    );
  }
  expectViolation(
    [
      {
        path: 'src/lifecycle/construction.ts',
        source: "export { build } from './local-export.js';\n",
      },
      {
        path: 'src/lifecycle/local-export.ts',
        source: "import { helper } from './helper.js';\nexport { helper as build };\n",
      },
      {
        path: 'src/lifecycle/helper.ts',
        source: 'export const helper = () => undefined;\n',
      },
    ],
    'lifecycle-port-boundary',
  );
  for (const storageReference of [
    "import type RunStore from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: RunStore }\n",
    "import type RunStoreInvalidInput from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: RunStoreInvalidInput }\n",
    "import type { RunStoreInvalidInput as Store } from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: Store }\n",
    "export interface RunLifecycleDependencies { readonly store: import('../storage/index.js').RunStoreInvalidInput }\n",
    "import type * as Storage from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: Storage.RunStoreInvalidInput }\n",
    "import Storage = require('../storage/index.js');\nexport interface RunLifecycleDependencies { readonly store: Storage.RunStoreInvalidInput }\n",
    "export interface RunLifecycleDependencies { readonly store: Storage.RunStoreInvalidInput }\nimport type * as Storage from '../storage/index.js';\n",
    "export type { RunStoreInvalidInput } from '../storage/index.js';\n",
  ]) {
    expectViolation(
      [
        {
          path: 'src/lifecycle/construction.ts',
          source:
            "export type { RunLifecycleDependencies } from './run-lifecycle-dependencies.js';\n",
        },
        {
          path: 'src/lifecycle/run-lifecycle-dependencies.ts',
          source: storageReference,
        },
      ],
      'lifecycle-port-boundary',
    );
  }
  for (const source of [
    'const create = () => undefined;\nexport { create as build };\n',
    'function create() { return undefined; }\nexport default create;\n',
    'const create = (): void => undefined;\nconst alias = create;\nexport { alias as build };\n',
    'class Create { get value() { return 1; } }\nexport { Create as default };\n',
  ]) {
    expectViolation(
      [
        {
          path: 'src/lifecycle/construction.ts',
          source: "export { build } from './local-export.js';\n",
        },
        { path: 'src/lifecycle/local-export.ts', source },
      ],
      'lifecycle-port-boundary',
    );
  }
  for (const source of [
    'export default (): void => undefined;\n',
    'export default class Create {}\n',
    'export default interface Create { readonly value: number }\n',
    'export default { create(): void {} };\n',
    'const create: () => void = () => undefined;\nexport default create;\n',
  ]) {
    expectViolation(
      [
        {
          path: 'src/lifecycle/construction.ts',
          source: "export { create } from './default-export.js';\n",
        },
        { path: 'src/lifecycle/default-export.ts', source },
      ],
      'lifecycle-port-boundary',
    );
  }
  for (const source of [
    'export class Create { readonly ["value"]: number = 1; }\n',
    'export class Create { ["run"](): void {} }\n',
    'export class Create { get ["value"](): number { return 1; } }\n',
    'export interface Create { readonly ["value"]: number }\n',
    'export interface Create { (): void }\n',
    'export interface Create { new (): Create }\n',
    'export interface Create { run(): void }\n',
    "import type { RunState } from '../domain/index.js';\nexport interface Create { [key: string]: RunState }\n",
    'export function Create({ value }: { value: number }): void { void value; }\n',
    'export const Create = ({ value }: { value: number }): void => { void value; };\n',
    'export type Create = ({ value }: { value: number }) => void;\n',
    'export interface Create { run({ value }: { value: number }): void }\n',
    'const local = { value: 1 };\nexport type Create = typeof local;\n',
    'const { local } = { local: 1 };\nexport type Create = typeof local;\n',
    'export class Create { readonly value: number = 1; }\n',
  ]) {
    expectViolation(
      [
        {
          path: 'src/lifecycle/construction.ts',
          source: "export type { Create } from './computed-or-index.js';\n",
        },
        { path: 'src/lifecycle/computed-or-index.ts', source },
      ],
      'lifecycle-port-boundary',
    );
  }
  for (const helperSource of [
    "export interface Helper { readonly plans: import('../ports/index.js').ExecutionPlanSource }\n",
    "import type * as Ports from '../ports/index.js';\nexport interface Helper { readonly plans: Ports.ExecutionPlanSource }\n",
    "import type PlanSource from '../ports/index.js';\ntype Private = PlanSource;\nexport class Helper { constructor(readonly plans: Private) {} }\n",
  ]) {
    expectViolation(
      [
        {
          path: 'src/lifecycle/construction.ts',
          source: "export { create } from './create.js';\n",
        },
        {
          path: 'src/lifecycle/create.ts',
          source:
            "import type { Helper } from './helper.js';\nexport declare function create(helper: Helper): void;\n",
        },
        { path: 'src/lifecycle/helper.ts', source: helperSource },
      ],
      'lifecycle-port-boundary',
    );
  }
  expectViolation(
    [
      {
        path: 'src/lifecycle/construction.ts',
        source: "export { create } from './create.js';\n",
      },
      {
        path: 'src/lifecycle/create.ts',
        source:
          "import type { Helper } from './helper.js';\nexport declare function create(helper: Helper): void;\n",
      },
      {
        path: 'src/lifecycle/helper.ts',
        source:
          "import type { ExecutionPlanSource } from '../ports/index.js';\nexport interface Helper { readonly plans: ExecutionPlanSource }\n",
      },
    ],
    'lifecycle-port-boundary',
  );
  expectViolation(
    [
      {
        path: 'src/lifecycle/construction.ts',
        source: "export { create } from './create.js';\n",
      },
      {
        path: 'src/lifecycle/create.ts',
        source:
          "import type { Helper } from './helper.js';\nexport declare function create(helper: Helper): void;\n",
      },
      {
        path: 'src/lifecycle/helper.ts',
        source:
          "import Next = require('./next.js');\nexport interface Helper { readonly next: Next.Deep }\n",
      },
      {
        path: 'src/lifecycle/next.ts',
        source:
          "import Ports = require('../ports/index.js');\nexport interface Deep { readonly plans: Ports.ExecutionPlanSource }\n",
      },
    ],
    'lifecycle-port-boundary',
  );
  expectViolation(
    [
      {
        path: 'src/lifecycle/index.ts',
        source: "export { createRunLifecycle } from './construction.js';\n",
      },
    ],
    'lifecycle-port-boundary',
  );
  expectViolation(
    [
      {
        path: 'src/lifecycle/construction.ts',
        source: "export type { Helper } from './helper.js';\n",
      },
      {
        path: 'src/lifecycle/helper.ts',
        source:
          "import type { ExecutionPlanSource as ExecutorResolver } from '../ports/index.js';\nexport interface Helper { readonly resolver: ExecutorResolver }\n",
      },
    ],
    'lifecycle-port-boundary',
  );
  expectViolation(
    [
      {
        path: 'src/lifecycle/construction.ts',
        source: "export type { Helper } from './helper.js';\n",
      },
      {
        path: 'src/lifecycle/helper.ts',
        source:
          "import Ports = require('../ports/index.js');\nexport interface Helper { readonly resolver: Ports.ExecutorResolver }\n",
      },
    ],
    'lifecycle-port-boundary',
  );
  expectViolation(
    [
      {
        path: 'src/lifecycle/construction.ts',
        source:
          "export type { ExecutionPlanSource as ExecutorResolver } from '../ports/index.js';\n",
      },
    ],
    'lifecycle-port-boundary',
  );
  expectViolation(
    [
      {
        path: 'src/lifecycle/construction.ts',
        source: "export type { Helper } from './helper.js';\n",
      },
      {
        path: 'src/lifecycle/helper.ts',
        source:
          "import type { RunState } from '../domain/index.js';\nexport interface Helper { readonly state: RunState }\n",
      },
    ],
    'lifecycle-port-boundary',
  );
  expect(() =>
    validateModuleStructure([
      {
        path: 'src/lifecycle/construction.ts',
        source: "export type { Dependencies } from './dependencies.js';\n",
      },
      {
        path: 'src/lifecycle/dependencies.ts',
        source:
          "import type { ExecutorResolver } from '../ports/index.js';\nexport interface Dependencies { readonly resolver: ExecutorResolver }\n",
      },
    ]),
  ).not.toThrow();
  for (const source of [
    'type T = number;\nexport type Create = <T extends string, U = T>(value: U) => T;\n',
    'type T = number;\nexport type Create = new <T extends string, U = T>(value: U) => { readonly value: T };\n',
    "import type { RunState } from '../domain/index.js';\ntype Private<T> = T extends (infer U extends RunState) ? U : T;\nexport interface Create { readonly safe: string }\n",
  ]) {
    expect(() =>
      validateModuleStructure([
        {
          path: 'src/lifecycle/construction.ts',
          source: "export type { Create } from './scope-safe.js';\n",
        },
        { path: 'src/lifecycle/scope-safe.ts', source },
      ]),
    ).not.toThrow();
  }
  expect(() =>
    validateModuleStructure([
      {
        path: 'src/lifecycle/construction.ts',
        source: "export type { Create } from './safe-hidden.js';\n",
      },
      {
        path: 'src/lifecycle/safe-hidden.ts',
        source:
          'class UnusedClass {}\ninterface UnusedCallable { (): void }\nconst { unused } = { unused: 1 };\ntype Safe<T extends string = string> = { readonly value: T };\nexport interface Create { readonly safe: Safe<"ok"> }\nvoid unused;\n',
      },
    ]),
  ).not.toThrow();
  for (const source of [
    "import { runtimeOnly } from '../ports/index.js';\nconst create: () => void = () => runtimeOnly();\nexport { create };\n",
    "import { runtimeOnly } from '../ports/index.js';\nfunction create(): void { runtimeOnly(); }\nexport { create };\n",
  ]) {
    expect(() =>
      validateModuleStructure([
        {
          path: 'src/lifecycle/construction.ts',
          source: "export { create } from './typed-local.js';\n",
        },
        { path: 'src/lifecycle/typed-local.ts', source },
      ]),
    ).not.toThrow();
  }
  for (const storageReference of [
    "import type { RunStore as Store } from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: Store }\n",
    "import type * as Storage from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: Storage.RunStore }\n",
    "import type * as Storage from '../storage/index.js';\n// Storage.RunStoreInvalidInput is harmless trivia\nexport interface RunLifecycleDependencies { readonly store: Storage /* gap */ . RunStore }\n",
    "import Storage = require('../storage/index.js');\nexport interface RunLifecycleDependencies { readonly store: Storage.RunStore }\n",
    "export interface RunLifecycleDependencies { readonly store: Storage.RunStore }\nimport type * as Storage from '../storage/index.js';\n",
    "export interface RunLifecycleDependencies { readonly store: import('../storage/index.js').RunStore }\n",
    "export type { RunStore } from '../storage/index.js';\n",
  ]) {
    expect(() =>
      validateModuleStructure([
        {
          path: 'src/lifecycle/construction.ts',
          source:
            "export type { RunLifecycleDependencies } from './run-lifecycle-dependencies.js';\n",
        },
        {
          path: 'src/lifecycle/run-lifecycle-dependencies.ts',
          source: storageReference,
        },
      ]),
    ).not.toThrow();
  }
  expect(() =>
    validateModuleStructure([
      {
        path: 'src/lifecycle/construction.ts',
        source: "export { arrow } from './arrow.js';\nexport { declared } from './declared.js';\n",
      },
      {
        path: 'src/lifecycle/arrow.ts',
        source:
          "import { runtimeOnly } from '../ports/index.js';\nexport const arrow = (): void => runtimeOnly();\n",
      },
      {
        path: 'src/lifecycle/declared.ts',
        source:
          "import { runtimeOnly } from '../ports/index.js';\nexport function declared(): void { runtimeOnly(); }\n",
      },
    ]),
  ).not.toThrow();
  expect(() =>
    validateModuleStructure([
      {
        path: 'src/lifecycle/construction.ts',
        source: "export { Explicit } from './explicit-local.js';\n",
      },
      {
        path: 'src/lifecycle/explicit-local.ts',
        source: 'interface Explicit { readonly value: number }\nexport { Explicit };\n',
      },
    ]),
  ).not.toThrow();
}, 30_000);

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

test('allows canonical JSON dependencies only in their exact policy leaves', () => {
  expect(() =>
    validateModuleStructure([
      {
        path: 'src/policy/canonical-json/canonicalize-json.ts',
        source:
          "import canonicalize from 'canonicalize';\nexport const canonicalizeJson = (value: unknown): string | undefined => canonicalize(value);\n",
      },
      {
        path: 'src/policy/canonical-json/digest-canonical-json.ts',
        source:
          "import { createHash } from 'node:crypto';\nexport const digestCanonicalJson = (value: string): string => createHash('sha256').update(value).digest('hex');\n",
      },
    ]),
  ).not.toThrow();

  expectViolation(
    [
      {
        path: 'src/policy/other-canonicalizer.ts',
        source:
          "import canonicalize from 'canonicalize';\nexport const otherCanonicalizer = canonicalize;\n",
      },
    ],
    'canonical-json-import',
  );
  expectViolation(
    [
      {
        path: 'src/policy/canonical-json/canonicalize-json.ts',
        source:
          "import { createHash } from 'node:crypto';\nexport const canonicalizeJson = createHash;\n",
      },
    ],
    'canonical-json-crypto-import',
  );
  expectViolation(
    [
      {
        path: 'src/policy/canonical-json/digest-canonical-json.ts',
        source:
          "import canonicalize from 'canonicalize';\nexport const digestCanonicalJson = canonicalize;\n",
      },
    ],
    'canonical-json-import',
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
