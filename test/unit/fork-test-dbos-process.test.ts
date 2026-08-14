import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from '@babel/parser';
import {
  isAwaitExpression,
  isExportAllDeclaration,
  isExportNamedDeclaration,
  isExportNamespaceSpecifier,
  isExportSpecifier,
  isIdentifier,
  isImportDefaultSpecifier,
  isImportDeclaration,
  isImportExpression,
  isImportNamespaceSpecifier,
  isImportSpecifier,
  isMemberExpression,
  isObjectPattern,
  isObjectProperty,
  isParenthesizedExpression,
  isStringLiteral,
  isTSAsExpression,
  isTSNonNullExpression,
  isTSSatisfiesExpression,
  isTSTypeAssertion,
  isVariableDeclarator,
  traverseFast,
  type Node,
} from '@babel/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ChildProcess = import('node:child_process').ChildProcess;
type TestFork = (
  worker: string,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly execArgv: readonly string[];
    readonly silent: boolean;
  },
) => ChildProcess;

const childProcess = vi.hoisted(() => ({ fork: vi.fn<TestFork>() }));

vi.mock('node:child_process', () => ({ fork: childProcess.fork }));

import { forkTestDbosProcess } from '../support/process/fork-test-dbos-process.js';

const originalApplicationVersion = process.env['DBOS__APPVERSION'];
const originalInheritedValue = process.env['REVO_RUN_TEST_INHERITED_VALUE'];
const originalLayeredValue = process.env['REVO_RUN_TEST_LAYERED_VALUE'];

const childProcessModules = new Set(['node:child_process', 'child_process']);

const isChildProcessModule = (value: string): boolean => childProcessModules.has(value);

const unwrapTypeExpression = (node: Node | null | undefined): Node | undefined => {
  let current = node ?? undefined;
  while (
    current !== undefined &&
    (isParenthesizedExpression(current) ||
      isTSAsExpression(current) ||
      isTSNonNullExpression(current) ||
      isTSSatisfiesExpression(current) ||
      isTSTypeAssertion(current))
  ) {
    current = current.expression;
  }
  return current;
};

const isAwaitedChildProcessImport = (node: Node | null | undefined): boolean => {
  const expression = unwrapTypeExpression(node);
  if (!isAwaitExpression(expression)) {
    return false;
  }
  const awaited = unwrapTypeExpression(expression.argument);
  return (
    isImportExpression(awaited) &&
    isStringLiteral(awaited.source) &&
    isChildProcessModule(awaited.source.value)
  );
};

const isForkProperty = (node: Node, computed: boolean): boolean =>
  (!computed && isIdentifier(node, { name: 'fork' })) ||
  (computed && isStringLiteral(node, { value: 'fork' }));

const referencesModuleBinding = (
  node: Node | null | undefined,
  bindings: ReadonlySet<string>,
): boolean => {
  const expression = unwrapTypeExpression(node);
  return isIdentifier(expression) && bindings.has(expression.name);
};

const directChildProcessForkAccesses = (source: string): readonly string[] => {
  const syntax = parse(source, {
    createImportExpressions: true,
    plugins: ['typescript'],
    sourceType: 'module',
  });
  const childProcessModuleBindings = new Set<string>();
  const bindingAliases: { readonly local: string; readonly source: Node | null | undefined }[] = [];
  const accesses: string[] = [];

  traverseFast(syntax, (node) => {
    if (isImportDeclaration(node) && isChildProcessModule(node.source.value)) {
      for (const specifier of node.specifiers) {
        if (isImportNamespaceSpecifier(specifier) || isImportDefaultSpecifier(specifier)) {
          childProcessModuleBindings.add(specifier.local.name);
        } else if (
          isImportSpecifier(specifier) &&
          (isIdentifier(specifier.imported, { name: 'fork' }) ||
            isStringLiteral(specifier.imported, { value: 'fork' }))
        ) {
          accesses.push('named import');
        }
      }
    }

    if (
      isExportNamedDeclaration(node) &&
      node.source !== null &&
      node.source !== undefined &&
      isChildProcessModule(node.source.value) &&
      node.specifiers.some(
        (specifier) =>
          isExportNamespaceSpecifier(specifier) ||
          (isExportSpecifier(specifier) &&
            (isIdentifier(specifier.local, { name: 'fork' }) ||
              isStringLiteral(specifier.local, { value: 'fork' }))),
      )
    ) {
      accesses.push('named re-export');
    }

    if (isExportAllDeclaration(node) && isChildProcessModule(node.source.value)) {
      accesses.push('namespace re-export');
    }

    if (isVariableDeclarator(node) && isIdentifier(node.id)) {
      bindingAliases.push({ local: node.id.name, source: node.init });
    }
  });

  let addedBinding: boolean;
  do {
    addedBinding = false;
    for (const binding of bindingAliases) {
      const expression = unwrapTypeExpression(binding.source);
      if (
        !childProcessModuleBindings.has(binding.local) &&
        (isAwaitedChildProcessImport(expression) ||
          (isIdentifier(expression) && childProcessModuleBindings.has(expression.name)))
      ) {
        childProcessModuleBindings.add(binding.local);
        addedBinding = true;
      }
    }
  } while (addedBinding);

  traverseFast(syntax, (node) => {
    if (
      isMemberExpression(node) &&
      isForkProperty(node.property, node.computed) &&
      (referencesModuleBinding(node.object, childProcessModuleBindings) ||
        isAwaitedChildProcessImport(node.object))
    ) {
      accesses.push('module fork access');
    }

    if (
      isVariableDeclarator(node) &&
      isObjectPattern(node.id) &&
      (isAwaitedChildProcessImport(node.init) ||
        referencesModuleBinding(node.init, childProcessModuleBindings)) &&
      node.id.properties.some(
        (property) => isObjectProperty(property) && isForkProperty(property.key, property.computed),
      )
    ) {
      accesses.push('destructured fork access');
    }
  });

  return accesses;
};

const restoreEnvironmentVariable = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

afterEach(() => {
  childProcess.fork.mockReset();
  restoreEnvironmentVariable('DBOS__APPVERSION', originalApplicationVersion);
  restoreEnvironmentVariable('REVO_RUN_TEST_INHERITED_VALUE', originalInheritedValue);
  restoreEnvironmentVariable('REVO_RUN_TEST_LAYERED_VALUE', originalLayeredValue);
});

describe('DBOS test process fork boundary', () => {
  it.each(['', '   '])('rejects an empty application version: %j', (applicationVersion) => {
    expect(() => forkTestDbosProcess('/test/worker.ts', { applicationVersion, env: {} })).toThrow(
      'A DBOS test process application version is required.',
    );
    expect(childProcess.fork).not.toHaveBeenCalled();
  });

  it('owns process options and prevents ambient or caller version override', () => {
    process.env['DBOS__APPVERSION'] = 'ambient-version';
    process.env['REVO_RUN_TEST_INHERITED_VALUE'] = 'inherited-value';
    process.env['REVO_RUN_TEST_LAYERED_VALUE'] = 'ambient-value';

    forkTestDbosProcess('/test/worker.ts', {
      applicationVersion: 'required-version',
      env: {
        DBOS__APPVERSION: 'caller-version',
        REVO_RUN_TEST_LAYERED_VALUE: 'caller-value',
        REVO_RUN_TEST_VALUE: 'caller-value',
      },
    });

    expect(childProcess.fork).toHaveBeenCalledOnce();
    const call = childProcess.fork.mock.calls[0];
    expect(call?.[0]).toBe('/test/worker.ts');
    expect(call?.[1].env).toMatchObject({
      DBOS__APPVERSION: 'required-version',
      REVO_RUN_TEST_INHERITED_VALUE: 'inherited-value',
      REVO_RUN_TEST_LAYERED_VALUE: 'caller-value',
      REVO_RUN_TEST_VALUE: 'caller-value',
    });
    expect(call?.[1].execArgv).toStrictEqual(['--import', 'tsx']);
    expect(call?.[1].silent).toBe(true);
  });

  it('keeps direct test fork ownership behind the semantic helper boundary', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../..');
    const authorizedHelper = 'test/support/process/fork-test-dbos-process.ts';
    const testModules = globSync('test/**/*.ts', { cwd: repositoryRoot });
    const unauthorizedAccesses = testModules.flatMap((path) =>
      path === authorizedHelper
        ? []
        : directChildProcessForkAccesses(readFileSync(resolve(repositoryRoot, path), 'utf8')).map(
            (access) => ({ access, path }),
          ),
    );

    expect(unauthorizedAccesses).toStrictEqual([]);
    expect(
      directChildProcessForkAccesses(
        readFileSync(resolve(repositoryRoot, authorizedHelper), 'utf8'),
      ),
    ).toStrictEqual(['named import']);
  });

  it.each([
    ['named import', "import { fork } from 'node:child_process'; fork('/worker.js');"],
    [
      'namespace import',
      "import * as childProcess from 'node:child_process'; childProcess.fork('/worker.js');",
    ],
    [
      'default import',
      "import childProcess from 'node:child_process'; childProcess.fork('/worker.js');",
    ],
    [
      'computed default import',
      "import childProcess from 'node:child_process'; childProcess['fork']('/worker.js');",
    ],
    ['bare named import', "import { fork } from 'child_process'; fork('/worker.js');"],
    [
      'bare namespace import',
      "import * as childProcess from 'child_process'; childProcess.fork('/worker.js');",
    ],
    [
      'bare default import',
      "import childProcess from 'child_process'; childProcess.fork('/worker.js');",
    ],
    ['dynamic import', "(await import('node:child_process')).fork('/worker.js');"],
    ['computed dynamic import', "(await import('child_process'))['fork']('/worker.js');"],
    [
      'dynamic import alias',
      "const childProcess = await import('node:child_process'); childProcess.fork('/worker.js');",
    ],
    [
      'dynamic import destructuring',
      "const { fork: launch } = await import('child_process'); launch('/worker.js');",
    ],
  ])('detects a direct fork through %s', (_, source) => {
    expect(directChildProcessForkAccesses(source)).not.toHaveLength(0);
  });

  it('allows non-fork child-process APIs', () => {
    expect(
      directChildProcessForkAccesses(
        "import { spawnSync } from 'node:child_process'; spawnSync('node');",
      ),
    ).toStrictEqual([]);
    expect(
      directChildProcessForkAccesses("(await import('node:child_process')).spawnSync('node');"),
    ).toStrictEqual([]);
  });
});
