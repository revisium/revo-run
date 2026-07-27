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

const declarationModuleSpecifiers = (source: string): readonly string[] =>
  [
    ...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g),
  ].flatMap((match) => (match[1] ? [match[1]] : []));

const declarationReferences = (source: string): readonly string[] =>
  declarationModuleSpecifiers(source).filter((specifier) => specifier.startsWith('.'));

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
    path: 'src/policy/canonical-json/snapshot-json-value.ts',
    source:
      "import type { JsonValue } from '../../spec/index.js';\nexport const snapshotJsonValue = (value: JsonValue): JsonValue => value;\n",
  },
  {
    path: 'src/policy/canonical-json/canonicalize-json.ts',
    source:
      "import canonicalize from 'canonicalize';\nimport { snapshotJsonValue } from './snapshot-json-value.js';\nexport const canonicalizeJson = (value: null): string | undefined => canonicalize(snapshotJsonValue(value));\n",
  },
  {
    path: 'src/policy/canonical-json/digest-canonical-json.ts',
    source:
      "import { createHash } from 'node:crypto';\nimport { canonicalizeJson } from './canonicalize-json.js';\nexport const digestCanonicalJson = (value: null): string => createHash('sha256').update(canonicalizeJson(value) ?? '').digest('hex');\n",
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
    path: 'src/storage/run-store.ts',
    source: 'export interface RunStore { transaction(): Promise<void> }\n',
  },
  {
    path: 'src/storage/index.ts',
    source:
      "export type { RunStore } from './run-store.js';\nexport type { RunStorePort } from './run-store-port.js';\n",
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
    source: "export type { RunLifecycle } from './run-lifecycle.js';\n",
  },
  {
    path: 'src/lifecycle/run-lifecycle-dependencies.ts',
    source:
      "import type { ExecutorResolver } from '../ports/index.js';\nimport type { RunStore } from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly executors: ExecutorResolver; readonly store: RunStore }\n",
  },
  {
    path: 'src/lifecycle/create-run-lifecycle.ts',
    source:
      "import type { RunLifecycleDependencies } from './run-lifecycle-dependencies.js';\nexport const createRunLifecycle = (_dependencies: RunLifecycleDependencies): void => undefined;\n",
  },
  {
    path: 'src/lifecycle/generic-function-shadow.ts',
    source:
      'const hostile = 1;\ntype T = typeof hostile;\nexport function createShadow<T>(value: T): T { return value; }\n',
  },
  {
    path: 'src/lifecycle/generic-type-shadow.ts',
    source:
      'const hostile = 1;\ntype T = typeof hostile;\nexport type GenericShadow<T> = { readonly value: T };\n',
  },
  {
    path: 'src/lifecycle/interface-shadow.ts',
    source:
      'const hostile = 1;\ntype T = typeof hostile;\nexport interface InterfaceShadow<T> { readonly value: T }\n',
  },
  {
    path: 'src/lifecycle/property-shadow.ts',
    source:
      'const hostile = 1;\ntype collision = typeof hostile;\nexport type PropertyShadow = { readonly collision: string };\n',
  },
  {
    path: 'src/lifecycle/function-parameter-shadow.ts',
    source:
      'const hostile = 1;\ntype value = typeof hostile;\nexport type FunctionParameterShadow = (value: string) => string;\n',
  },
  {
    path: 'src/lifecycle/infer-constraint-shadow.ts',
    source:
      'const hostile = 1;\ntype T = typeof hostile;\nexport type InferConstraintShadow<T> = T extends (infer U extends T) ? U : T;\n',
  },
  {
    path: 'src/lifecycle/tuple-infer-constraint-shadow.ts',
    source:
      'const hostile = 1;\ntype X = typeof hostile;\nexport type TupleInferConstraintShadow<X> = X extends readonly [infer U extends X, ...unknown[]] ? U : X;\n',
  },
  {
    path: 'src/lifecycle/construction.ts',
    source:
      "export { createRunLifecycle } from './create-run-lifecycle.js';\nexport { createShadow } from './generic-function-shadow.js';\nexport type { FunctionParameterShadow } from './function-parameter-shadow.js';\nexport type { GenericShadow } from './generic-type-shadow.js';\nexport type { InferConstraintShadow } from './infer-constraint-shadow.js';\nexport type { InterfaceShadow } from './interface-shadow.js';\nexport type { PropertyShadow } from './property-shadow.js';\nexport type { RunLifecycleDependencies } from './run-lifecycle-dependencies.js';\nexport type { TupleInferConstraintShadow } from './tuple-infer-constraint-shadow.js';\n",
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
      "import { createRunLifecycle } from '../lifecycle/construction.js';\nimport { advanceLifecycle, type RunLifecycle } from '../lifecycle/index.js';\nimport { buildRunManager } from '../manager/index.js';\nimport type { ExecutionPlanSource, ExecutorResolver } from '../ports/index.js';\nimport type { RunInput } from '../spec/index.js';\nimport type { RunStorePort } from '../storage/index.js';\nexport const createRunManager = (input: RunInput, store: RunStorePort, plans: ExecutionPlanSource, executors: ExecutorResolver): number => { createRunLifecycle({ executors, store }); const lifecycle: RunLifecycle = { advance: (value) => advanceLifecycle(value, store, plans) }; return buildRunManager(lifecycle, plans, input); };\n",
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
validateModuleStructure([
  {
    path: 'src/lifecycle/construction.ts',
    source:
      "export { createArrow } from './runtime-arrow.js';\nexport { createFunction } from './runtime-function.js';\n",
  },
  {
    path: 'src/lifecycle/runtime-function.ts',
    source:
      "import { runtimeOnly } from '../ports/index.js';\nexport function createFunction(): void { runtimeOnly(); }\n",
  },
  {
    path: 'src/lifecycle/runtime-arrow.ts',
    source:
      "import { runtimeOnly } from '../ports/index.js';\nexport const createArrow = (): void => runtimeOnly();\n",
  },
]);

execFileSync(
  join(root, 'node_modules/.bin/oxlint'),
  ['--config', '.oxlintrc.architecture.json', '--deny-warnings', 'src'],
  { cwd: root, stdio: 'pipe' },
);

const probes: readonly (readonly [ArchitectureRule, readonly SourceModule[]])[] = [
  [
    'manager-store-reference',
    [
      {
        path: 'src/manager/run-manager.ts',
        source:
          'interface RunStore { readonly marker: string }\nexport interface ManagerState { readonly marker: RunStore }\n',
      },
    ],
  ],
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/run-lifecycle-dependencies.ts',
        source:
          "import type { ExecutionPlanSource } from '../ports/index.js';\nexport interface RunLifecycleDependencies { readonly plans: ExecutionPlanSource }\n",
      },
    ],
  ],
  ...(
    [
      [
        'inline import type',
        "export interface Helper { readonly plans: import('../ports/index.js').ExecutionPlanSource }\n",
      ],
      [
        'namespace import',
        "import type * as Ports from '../ports/index.js';\nexport interface Helper { readonly plans: Ports.ExecutionPlanSource }\n",
      ],
      [
        'default type import',
        "import type PlanSource from '../ports/index.js';\nexport interface Helper { readonly plans: PlanSource }\n",
      ],
      [
        'private alias chain',
        "import type { ExecutionPlanSource } from '../ports/index.js';\ntype Private = ExecutionPlanSource;\nexport interface Helper { readonly plans: Private }\n",
      ],
      [
        'class surface',
        "import type { ExecutionPlanSource } from '../ports/index.js';\nexport class Helper { constructor(readonly plans: ExecutionPlanSource) {} method(): ExecutionPlanSource { throw new Error('unused') } }\n",
      ],
    ] as const
  ).map(
    ([_name, helperSource]) =>
      [
        'lifecycle-port-boundary',
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
      ] as const,
  ),
  ...[
    'export function create() { return undefined; }\n',
    'export const create = () => undefined;\n',
    'export class create { method() { return undefined; } }\n',
    'export class create { get value() { return 1; } }\n',
    'export class create { readonly value = 1; }\n',
    'const local = (): void => undefined;\nexport const create = local;\n',
    "import { advanceRun } from '../domain/index.js';\nconst { create } = { create: advanceRun };\nexport { create };\n",
    "import type { RunState } from '../domain/index.js';\nexport function create<T extends RunState>(): void {}\n",
    "import type { ExecutionPlanSource } from '../ports/index.js';\nexport function create<T = ExecutionPlanSource>(): void {}\n",
    'export default (): void => undefined;\n',
    'export default class create {}\n',
    'export default interface create { readonly value: number }\n',
    'export default { create(): void {} };\n',
    'const create: () => void = () => undefined;\nexport default create;\n',
    'export class create { readonly ["value"]: number = 1; }\n',
    'export interface create { readonly ["value"]: number }\n',
    'export interface create { (): void }\n',
    'export interface create { new (): create }\n',
    'export interface create { run(): void }\n',
    'export interface create { [key: string]: number }\n',
    'export function create({ value }: { value: number }): void { void value; }\n',
    'export const create = ({ value }: { value: number }): void => { void value; };\n',
    'export type create = ({ value }: { value: number }) => void;\n',
    'const local = { value: 1 };\nexport type create = typeof local;\n',
    'const hostile = 1;\ntype Alias = typeof hostile;\nexport type create<T> = T extends (infer U extends Alias) ? U : T;\n',
    "import type { RunState } from '../domain/index.js';\nexport type create<T> = T extends (infer U extends RunState) ? U : T;\n",
    "import type { RunState } from '../domain/index.js';\nexport type create<T> = T extends readonly [infer U extends RunState, ...unknown[]] ? U : T;\n",
    "export type create<T> = T extends (infer U extends import('../domain/index.js').RunState) ? U : T;\n",
    "import type { RunState } from '../domain/index.js';\nexport type create<T> = T extends (infer U extends { readonly state: RunState }) ? U : T;\n",
    "import type { RunState } from '../domain/index.js';\ndeclare const key: unique symbol;\nexport interface create { readonly [key]: RunState }\n",
    "import { advanceRun } from '../domain/index.js';\nconst hidden = advanceRun;\ntype Hidden = typeof hidden;\nexport interface create { readonly hidden: Hidden }\n",
    'interface Hidden { (): void }\nexport interface create { readonly hidden: Hidden }\n',
    'class Hidden {}\nexport interface create { readonly hidden: Hidden }\n',
    'interface Hidden { readonly ["value"]: number }\nexport interface create { readonly hidden: Hidden }\n',
    'interface Hidden { run(): void }\nexport const create: Hidden = {} as Hidden;\n',
    'type Hidden = ({ value }: { value: number }) => void;\nexport interface create { readonly hidden: Hidden }\n',
    "import type { RunState } from '../domain/index.js';\ntype Hidden<T extends RunState = RunState> = { readonly value: T };\nexport interface create { readonly hidden: Hidden<RunState> }\n",
    "import type { RunState } from '../domain/index.js';\nexport interface create { [key: string]: RunState }\n",
  ].map(
    (source) =>
      [
        'lifecycle-port-boundary',
        [
          {
            path: 'src/lifecycle/construction.ts',
            source: "export { create } from './inferred.js';\n",
          },
          { path: 'src/lifecycle/inferred.ts', source },
        ],
      ] as const,
  ),
  ...[
    "import type RunStoreInvalidInput from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: RunStoreInvalidInput }\n",
    "import type { RunStoreInvalidInput as Store } from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: Store }\n",
    "export interface RunLifecycleDependencies { readonly store: import('../storage/index.js').RunStoreInvalidInput }\n",
    "import type * as Storage from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: Storage.RunStoreInvalidInput }\n",
    "import type * as Storage from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly store: Storage /* gap */ . RunStoreInvalidInput }\n",
    "import Storage = require('../storage/index.js');\nexport interface RunLifecycleDependencies { readonly store: Storage.RunStoreInvalidInput }\n",
    "export interface RunLifecycleDependencies { readonly store: Storage.RunStoreInvalidInput }\nimport type * as Storage from '../storage/index.js';\n",
    "export type { RunStoreInvalidInput } from '../storage/index.js';\n",
  ].map(
    (source) =>
      [
        'lifecycle-port-boundary',
        [
          {
            path: 'src/lifecycle/construction.ts',
            source:
              "export type { RunLifecycleDependencies } from './run-lifecycle-dependencies.js';\n",
          },
          { path: 'src/lifecycle/run-lifecycle-dependencies.ts', source },
        ],
      ] as const,
  ),
  [
    'lifecycle-port-boundary',
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
  ],
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/construction.ts',
        source: "export { create } from './create.js';\n",
      },
      {
        path: 'src/lifecycle/create.ts',
        source: "import { helper } from './helper.js';\nexport const create = helper;\n",
      },
      {
        path: 'src/lifecycle/helper.ts',
        source:
          "import type { ExecutionPlanSource } from '../ports/index.js';\nexport declare function helper(plans: ExecutionPlanSource): void;\n",
      },
    ],
  ],
  ...(
    [
      [
        'port',
        "import type { ExecutionPlanSource } from '../ports/index.js';\nexport interface Helper { readonly plans: ExecutionPlanSource }\n",
      ],
      [
        'storage',
        "import type { RunStore } from '../storage/index.js';\nexport interface Helper { readonly store: RunStore }\n",
      ],
      [
        'domain',
        "import type { RunState } from '../domain/index.js';\nexport interface Helper { readonly state: RunState }\n",
      ],
    ] as const
  ).map(
    ([_name, helperSource]) =>
      [
        'lifecycle-port-boundary',
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
      ] as const,
  ),
  [
    'lifecycle-port-boundary',
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
  ],
  ...(
    [
      [
        'storage',
        "import type { RunStore } from '../storage/index.js';\nexport interface Leak { readonly store: RunStore }\n",
      ],
      [
        'domain',
        "import type { RunState } from '../domain/index.js';\nexport interface Leak { readonly state: RunState }\n",
      ],
      [
        'pipeline',
        "import type { PrivatePipeline } from './pipeline/private.js';\nexport interface Leak { readonly pipeline: PrivatePipeline }\n",
      ],
      ['provider', 'export interface Leak { readonly provider: ProviderPayload }\n'],
    ] as const
  ).map(
    ([name, source]) =>
      [
        'lifecycle-port-boundary',
        [
          {
            path: 'src/lifecycle/index.ts',
            source: "export type { Leak } from './boundary-leak.js';\n",
          },
          {
            path: 'src/lifecycle/boundary-leak.ts',
            source:
              name === 'provider'
                ? `import type { ProviderPayload } from '../provider/index.js';\n${source}`
                : source,
          },
        ],
      ] as const,
  ),
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/index.ts',
        source: "export { createRunLifecycle } from './construction.js';\n",
      },
    ],
  ],
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/construction.ts',
        source: "export type { Helper } from './construction-helper.js';\n",
      },
      {
        path: 'src/lifecycle/construction-helper.ts',
        source:
          "import type { ExecutionPlanSource } from '../ports/index.js';\nexport interface Helper { readonly plans: ExecutionPlanSource }\n",
      },
    ],
  ],
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/construction.ts',
        source:
          "export type { ExecutionPlanSource as ExecutorResolver } from '../ports/index.js';\n",
      },
    ],
  ],
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/construction.ts',
        source: "export type { Helper } from './construction-helper.js';\n",
      },
      {
        path: 'src/lifecycle/construction-helper.ts',
        source:
          "import Ports = require('../ports/index.js');\nexport interface Helper { readonly resolver: Ports.ExecutorResolver }\n",
      },
    ],
  ],
  ...(
    [
      [
        'storage',
        "import type { RunStore } from '../storage/index.js';\nexport interface Helper { readonly store: RunStore }\n",
      ],
      [
        'domain',
        "import type { RunState } from '../domain/index.js';\nexport interface Helper { readonly state: RunState }\n",
      ],
    ] as const
  ).map(
    ([name, source]) =>
      [
        'lifecycle-port-boundary',
        [
          {
            path: 'src/lifecycle/construction.ts',
            source: "export type { Helper } from './construction-helper.js';\n",
          },
          { path: 'src/lifecycle/construction-helper.ts', source: `${source}// ${name}\n` },
        ],
      ] as const,
  ),
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/run-lifecycle-dependencies.ts',
        source:
          "import type { ExecutionPlanSource as ExecutorResolver } from '../ports/index.js';\nexport interface RunLifecycleDependencies { readonly plans: ExecutorResolver }\n",
      },
    ],
  ],
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/run-lifecycle-dependencies.ts',
        source:
          "export interface RunLifecycleDependencies { readonly plans: import('../ports/index.js').ExecutionPlanSource }\n",
      },
    ],
  ],
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/index.ts',
        source: "export type { LeakedResult } from './leaked-result.js';\n",
      },
      {
        path: 'src/lifecycle/leaked-result.ts',
        source:
          "import type { ExecutorResult } from '../ports/index.js';\nexport interface LeakedResult { readonly result: ExecutorResult }\n",
      },
    ],
  ],
  [
    'lifecycle-port-boundary',
    [
      {
        path: 'src/lifecycle/run-lifecycle.ts',
        source:
          "import type { ResolvedExecutor } from '../ports/index.js';\nexport interface RunLifecycle { readonly executor: ResolvedExecutor }\n",
      },
    ],
  ],
  [
    'canonical-json-import',
    [
      {
        path: 'src/policy/other-canonicalizer.ts',
        source:
          "import canonicalize from 'canonicalize';\nexport const otherCanonicalizer = canonicalize;\n",
      },
    ],
  ],
  [
    'canonical-json-crypto-import',
    [
      {
        path: 'src/policy/canonical-json/canonicalize-json.ts',
        source:
          "import { createHash } from 'node:crypto';\nexport const canonicalizeJson = createHash;\n",
      },
    ],
  ],
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
        types: ['node'],
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

  const storePositiveRoot = join(declarationProbeRoot, 'store-positive');
  await writeFixtureFiles(storePositiveRoot, {
    'tsconfig.json': commonFiles['tsconfig.json'],
    'src/errors/index.ts':
      'export type ExecutorFailureFaultCode = "EXECUTOR_MISMATCH" | "EXECUTOR_UNAVAILABLE" | "INVALID_INPUT" | "INVALID_STATE" | "PLAN_MISMATCH" | "PLAN_UNAVAILABLE" | "REVISION_CONFLICT" | "STALE_ACTIVATION" | "STALE_FENCE";\nexport interface ExecutorFailureFault { readonly code: ExecutorFailureFaultCode; readonly message: string }\n',
    'src/ports/index.ts': 'export interface ExecutorResolver { resolveExact(): Promise<void> }\n',
    'src/storage/index.ts': 'export interface RunStore { transaction(): Promise<void> }\n',
    'src/lifecycle/lifecycle-observation.ts':
      'import type { ExecutorFailureFault } from "../errors/index.js";\nexport type LifecycleObservation = { readonly kind: "running" } | { readonly kind: "unknown" } | { readonly kind: "failed"; readonly fault: ExecutorFailureFault };\nexport interface LifecyclePreparedReconcileCall { readonly kind: "reconcile"; readonly reconcile: { readonly invoke: () => Promise<LifecycleObservation> } }\n',
    'src/lifecycle/run-lifecycle.ts':
      "import type { LifecycleObservation, LifecyclePreparedReconcileCall } from './lifecycle-observation.js';\nexport interface RunLifecycle { discover(): Promise<void>; claim(): Promise<void>; renewLease(): Promise<void>; writeHandoff(): Promise<void>; acquire(): Promise<void>; verifyAndStart(): Promise<void>; prepareReconciliation(): Promise<LifecyclePreparedReconcileCall>; processExecuteObservation(): Promise<LifecycleObservation>; processReconcileObservation(): Promise<LifecycleObservation> }\n",
    'src/lifecycle/run-lifecycle-dependencies.ts':
      "import type { ExecutorResolver } from '../ports/index.js';\nimport type { RunStore } from '../storage/index.js';\nexport interface RunLifecycleDependencies { readonly executors: ExecutorResolver; readonly store: RunStore }\n",
    'src/lifecycle/create-run-lifecycle.ts':
      "import type { RunLifecycleDependencies } from './run-lifecycle-dependencies.js';\nimport type { RunLifecycle } from './run-lifecycle.js';\nexport declare const createRunLifecycle: (dependencies: RunLifecycleDependencies) => RunLifecycle;\n",
    'src/lifecycle/construction.ts':
      "export { createRunLifecycle } from './create-run-lifecycle.js';\nexport type { RunLifecycleDependencies } from './run-lifecycle-dependencies.js';\n",
    'src/lifecycle/index.ts':
      "export type { LifecycleObservation, LifecyclePreparedReconcileCall } from './lifecycle-observation.js';\nexport type { RunLifecycle } from './run-lifecycle.js';\n",
  });
  const storeNegativeRoot = join(declarationProbeRoot, 'store-negative');
  await writeFixtureFiles(storeNegativeRoot, {
    'tsconfig.json': commonFiles['tsconfig.json'],
    'src/domain/index.ts': 'export interface RunState { readonly revision: number }\n',
    'src/pipeline/index.ts':
      'export interface DecodedPipeline { readonly nodes: readonly string[] }\n',
    'src/provider/index.ts': 'export interface ProviderPayload { readonly opaque: string }\n',
    'src/ports/index.ts':
      'export interface ResolvedExecutor { execute(): Promise<void>; reconcile(): Promise<void>; cancel(): Promise<void> }\nexport type ExecutorResolution = { readonly kind: "resolved"; readonly executor: ResolvedExecutor }\nexport interface ExecutorRequest { readonly operation: "execute" }\nexport interface ExecutorResult { readonly kind: "completed" }\nexport interface ExecutorExecuteResult { readonly kind: "executed" }\nexport interface ExecutorReconcileResult { readonly kind: "reconciled" }\nexport interface ExecutorCancelResult { readonly kind: "cancelled" }\n',
    'src/storage/index.ts': 'export interface RunStore { transaction(): Promise<void> }\n',
    'src/lifecycle/index.ts':
      "import type { RunState } from '../domain/index.js';\nimport type { DecodedPipeline } from '../pipeline/index.js';\nimport type { ExecutorCancelResult, ExecutorExecuteResult, ExecutorReconcileResult, ExecutorRequest, ExecutorResolution, ExecutorResult, ResolvedExecutor } from '../ports/index.js';\nimport type { ProviderPayload } from '../provider/index.js';\nimport type { RunStore } from '../storage/index.js';\nexport interface RunLifecycle { readonly store: RunStore; readonly state: RunState; readonly pipeline: DecodedPipeline; readonly executor: ResolvedExecutor; readonly resolution: ExecutorResolution; readonly request: ExecutorRequest; readonly result: ExecutorResult; readonly executeResult: ExecutorExecuteResult; readonly reconcileResult: ExecutorReconcileResult; readonly cancelResult: ExecutorCancelResult; readonly provider: ProviderPayload; reconcile(): Promise<void>; cancel(): Promise<void> }\n",
  });
  for (const fixtureRoot of [storePositiveRoot, storeNegativeRoot]) {
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
      cwd: fixtureRoot,
      stdio: 'pipe',
    });
  }
  const failureCodeNegativeRoot = join(declarationProbeRoot, 'failure-code-negative');
  await writeFixtureFiles(failureCodeNegativeRoot, {
    'tsconfig.json': commonFiles['tsconfig.json'],
    'src/errors/index.ts':
      'export type ExecutorFailureFaultCode = "EXECUTOR_MISMATCH" | "EXECUTOR_UNAVAILABLE" | "INVALID_INPUT" | "INVALID_STATE" | "PLAN_MISMATCH" | "PLAN_UNAVAILABLE" | "REVISION_CONFLICT" | "STALE_ACTIVATION" | "STALE_FENCE";\n',
    'src/index.ts':
      'import type { ExecutorFailureFaultCode } from "./errors/index.js";\nexport const cancelled: ExecutorFailureFaultCode = "CANCELLED";\nexport const notFound: ExecutorFailureFaultCode = "NOT_FOUND";\nexport const unknown: ExecutorFailureFaultCode = "UNKNOWN_OUTCOME";\n',
  });
  const failureCodeNegative = spawnSync(
    join(root, 'node_modules/.bin/tsc'),
    ['-p', 'tsconfig.json'],
    { cwd: failureCodeNegativeRoot, encoding: 'utf8' },
  );
  assert.notEqual(
    failureCodeNegative.status,
    0,
    'Excluded lifecycle failure codes must fail TypeScript compilation',
  );
  assert.match(
    `${failureCodeNegative.stdout}${failureCodeNegative.stderr}`,
    /"CANCELLED"[\s\S]*"NOT_FOUND"[\s\S]*"UNKNOWN_OUTCOME"/,
    'Failure-code negative proof must reject cancellation, not-found, and unknown outcomes',
  );
  const operationalLeakMarkers = [
    /\bRunStore\b|\/storage\//,
    /\bRunState\b|\/domain\//,
    /\bDecodedPipeline\b|\/pipeline\//,
    /\bProviderPayload\b|\/provider\//,
    /\bResolvedExecutor\b/,
    /\bExecutorResolution\b/,
    /\bExecutorRequest\b/,
    /\bExecutorResult\b/,
    /\bExecutorExecuteResult\b/,
    /\bExecutorReconcileResult\b/,
    /\bExecutorCancelResult\b/,
    /\bcancel\b/,
  ] as const;
  const positiveOperationalDeclarations = readReachableDeclarations(
    join(storePositiveRoot, 'dist/lifecycle/index.d.ts'),
  );
  const negativeOperationalDeclarations = readReachableDeclarations(
    join(storeNegativeRoot, 'dist/lifecycle/index.d.ts'),
  );
  assert.match(
    positiveOperationalDeclarations,
    /ExecutorFailureFault/,
    'Operational lifecycle declarations must retain the package-owned executor failure fault',
  );
  for (const leakMarker of operationalLeakMarkers) {
    assert.doesNotMatch(
      positiveOperationalDeclarations,
      leakMarker,
      `Operational lifecycle declarations must not expose ${leakMarker.source}`,
    );
    assert.match(
      negativeOperationalDeclarations,
      leakMarker,
      `Reachable declaration scan must detect ${leakMarker.source}`,
    );
  }
  const storeMarker = /\bRunStore\b|\/storage\//;
  assert.doesNotMatch(
    positiveOperationalDeclarations,
    storeMarker,
    'Store must not be reachable from manager-facing lifecycle declarations',
  );
  assert.match(
    readReachableDeclarations(join(storeNegativeRoot, 'dist/lifecycle/index.d.ts')),
    storeMarker,
    'Reachable declaration scan must detect a Store-bearing lifecycle facade',
  );

  const canonicalCommonFiles = {
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
        types: ['node'],
      },
      include: ['src/**/*.ts'],
    }),
    'src/spec/index.ts':
      'export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };\nexport type CanonicalJsonSha256Digest = `sha256:${string}`;\n',
    'src/policy/canonical-json/index.ts':
      "export { canonicalizeJson } from './canonicalize-json.js';\nexport { digestCanonicalJson } from './digest-canonical-json.js';\nexport type { CanonicalJsonSha256Digest, JsonValue } from '../../spec/index.js';\n",
  } as const;
  const canonicalEntry = 'dist/policy/canonical-json/index.d.ts';

  const canonicalPositiveRoot = join(declarationProbeRoot, 'canonical-positive');
  await writeFixtureFiles(canonicalPositiveRoot, {
    ...canonicalCommonFiles,
    'src/policy/canonical-json/canonicalize-json.ts':
      'export declare const canonicalizeJson: (value: unknown) => string;\n',
    'src/policy/canonical-json/digest-canonical-json.ts':
      "import type { CanonicalJsonSha256Digest } from '../../spec/index.js';\nexport declare const digestCanonicalJson: (value: unknown) => CanonicalJsonSha256Digest;\n",
  });

  const canonicalizeNegativeRoot = join(declarationProbeRoot, 'canonicalize-negative');
  await writeFixtureFiles(canonicalizeNegativeRoot, {
    ...canonicalCommonFiles,
    'src/policy/canonical-json/canonicalize-json.ts':
      "import type canonicalize from 'canonicalize';\nexport declare const canonicalizeJson: typeof canonicalize;\n",
    'src/policy/canonical-json/digest-canonical-json.ts':
      "import type { CanonicalJsonSha256Digest } from '../../spec/index.js';\nexport declare const digestCanonicalJson: (value: unknown) => CanonicalJsonSha256Digest;\n",
  });

  const canonicalizeInlineNegativeRoot = join(declarationProbeRoot, 'canonicalize-inline-negative');
  await writeFixtureFiles(canonicalizeInlineNegativeRoot, {
    ...canonicalCommonFiles,
    'src/policy/canonical-json/canonicalize-json.ts':
      "export declare const canonicalizeJson: typeof import('canonicalize').default;\n",
    'src/policy/canonical-json/digest-canonical-json.ts':
      "import type { CanonicalJsonSha256Digest } from '../../spec/index.js';\nexport declare const digestCanonicalJson: (value: unknown) => CanonicalJsonSha256Digest;\n",
  });

  const cryptoNegativeRoot = join(declarationProbeRoot, 'crypto-negative');
  await writeFixtureFiles(cryptoNegativeRoot, {
    ...canonicalCommonFiles,
    'src/policy/canonical-json/canonicalize-json.ts':
      'export declare const canonicalizeJson: (value: unknown) => string;\n',
    'src/policy/canonical-json/digest-canonical-json.ts':
      "import type { createHash } from 'node:crypto';\nexport declare const digestCanonicalJson: typeof createHash;\n",
  });

  const cryptoRequireNegativeRoot = join(declarationProbeRoot, 'crypto-require-negative');
  await writeFixtureFiles(cryptoRequireNegativeRoot, {
    ...canonicalCommonFiles,
    'src/policy/canonical-json/canonicalize-json.ts':
      'export declare const canonicalizeJson: (value: unknown) => string;\n',
    'src/policy/canonical-json/digest-canonical-json.ts':
      "import crypto = require('node:crypto');\nexport declare const digestCanonicalJson: typeof crypto.createHash;\n",
  });

  for (const fixtureRoot of [
    canonicalPositiveRoot,
    canonicalizeNegativeRoot,
    canonicalizeInlineNegativeRoot,
    cryptoNegativeRoot,
    cryptoRequireNegativeRoot,
  ]) {
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
      cwd: fixtureRoot,
      stdio: 'pipe',
    });
  }

  const runtimeDependencySpecifiers = (fixtureRoot: string): readonly string[] =>
    declarationModuleSpecifiers(
      readReachableDeclarations(join(fixtureRoot, canonicalEntry)),
    ).filter((specifier) => specifier === 'canonicalize' || specifier === 'node:crypto');
  assert.deepEqual(
    runtimeDependencySpecifiers(canonicalPositiveRoot),
    [],
    'Canonical JSON positive declarations must not expose runtime dependencies',
  );
  assert.deepEqual(
    runtimeDependencySpecifiers(canonicalizeNegativeRoot),
    ['canonicalize'],
    'Canonical JSON declaration scan must detect a transitive canonicalize import leak',
  );
  assert.deepEqual(
    runtimeDependencySpecifiers(canonicalizeInlineNegativeRoot),
    ['canonicalize'],
    'Canonical JSON declaration scan must detect a transitive inline import leak',
  );
  assert.deepEqual(
    runtimeDependencySpecifiers(cryptoNegativeRoot),
    ['node:crypto'],
    'Canonical JSON declaration scan must detect a transitive node:crypto import leak',
  );
  assert.deepEqual(
    runtimeDependencySpecifiers(cryptoRequireNegativeRoot),
    ['node:crypto'],
    'Canonical JSON declaration scan must detect a transitive import-equals require leak',
  );
} finally {
  await rm(declarationProbeRoot, { recursive: true, force: true });
}

const temporaryRoot = await mkdtemp(join(root, '.architecture-probe-'));
try {
  const lintProbes = [
    {
      name: 'operational exact MCP baseline',
      path: 'src/lifecycle/index.ts',
      source:
        "import type { Server } from '@modelcontextprotocol/sdk/server/index.js';\nexport type { Server };\n",
      expectedMessage: 'MCP transport and server dependencies belong to the host, not revo-run.',
      expectedCount: 2,
    },
    {
      name: 'construction exact Nest baseline',
      path: 'src/lifecycle/construction.ts',
      source:
        "import type { Injectable } from '@nestjs/common';\nexport type ConstructionProbe = Injectable;\n",
      expectedMessage:
        'Database frameworks, worker runtimes, queues, and API transports are outside revo-run.',
    },
    {
      name: 'construction helper non-resolver port',
      path: 'src/lifecycle/construction-helper.ts',
      source:
        "import type { ExecutionPlanSource } from '../ports/index.js';\nexport interface Probe { readonly plans: ExecutionPlanSource }\n",
      expectedMessage: 'Lifecycle modules may import only ExecutorResolver from ports.',
    },
    {
      name: 'construction non-resolver port',
      path: 'src/lifecycle/run-lifecycle-dependencies.ts',
      source:
        "import type { ExecutionPlanSource } from '../ports/index.js';\nexport interface Probe { readonly plans: ExecutionPlanSource }\n",
      expectedMessage: 'Lifecycle modules may import only ExecutorResolver from ports.',
    },
    {
      name: 'construction aliased non-resolver port',
      path: 'src/lifecycle/create-run-lifecycle.ts',
      source:
        "import type { ExecutionPlanSource as ExecutorResolver } from '../ports/index.js';\nexport interface Probe { readonly plans: ExecutorResolver }\n",
      expectedMessage: 'Lifecycle modules may import only ExecutorResolver from ports.',
    },
    {
      name: 'operational runtime port',
      path: 'src/lifecycle/run-lifecycle.ts',
      source:
        "import type { ExecutorReconcileResult, ResolvedExecutor } from '../ports/index.js';\nexport interface Probe { readonly executor: ResolvedExecutor; readonly result: ExecutorReconcileResult }\n",
      expectedMessage: 'Operational lifecycle declarations must not import runtime port types.',
    },
    {
      name: 'canonicalize misplacement',
      path: 'src/policy/canonicalize-probe.ts',
      source: "import canonicalize from 'canonicalize';\nexport const probe = canonicalize;\n",
      expectedMessage: 'canonicalize is restricted to the canonical JSON policy implementation.',
    },
    {
      name: 'canonical JSON crypto misplacement',
      path: 'src/policy/crypto-probe.ts',
      source: "import { createHash } from 'node:crypto';\nexport const probe = createHash;\n",
      expectedMessage: 'node:crypto is restricted to canonical JSON digest implementation.',
    },
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
        'expectedCount' in probe ? probe.expectedCount : 1,
        `${probe.name} fixture must match the expected configured restrictions`,
      );
      for (const diagnostic of lintOutput.diagnostics) {
        assert.ok(isRecord(diagnostic), `${probe.name} Oxc diagnostic must be an object`);
        assert.equal(diagnostic.code, 'eslint(no-restricted-imports)');
        assert.equal(diagnostic.help, probe.expectedMessage);
      }
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
