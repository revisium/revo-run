import { dirname, posix } from 'node:path';

import {
  ModifierFlags,
  SyntaxKind,
  isArrayBindingPattern,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isExternalModuleReference,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isNamedExports,
  isNamespaceExportDeclaration,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
  type BindingName,
  type Node,
  type SourceFile,
  type Statement,
} from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';

export interface SourceModule {
  readonly path: string;
  readonly source: string;
}

export type ArchitectureRule =
  | 'explicit-barrel-exports'
  | 'external-import'
  | 'forbidden-layer-import'
  | 'forbidden-mcp-import'
  | 'forbidden-orchestrator-import'
  | 'forbidden-production-import'
  | 'one-export-per-leaf'
  | 'own-barrel-import'
  | 'private-import'
  | 'relative-js-suffix'
  | 'test-private-import'
  | 'type-cycle'
  | 'type-only-layer'
  | 'unknown-layer';

interface ModuleReference {
  readonly specifier: string;
  readonly target?: string;
}

type Layer = 'domain' | 'errors' | 'lifecycle' | 'policy' | 'spec' | 'storage';

const layers: readonly Layer[] = ['spec', 'policy', 'errors', 'domain', 'storage', 'lifecycle'];

const allowedDependencies: Readonly<Record<Layer, readonly Layer[]>> = {
  spec: [],
  policy: ['spec'],
  errors: ['spec'],
  domain: ['spec', 'policy', 'errors'],
  storage: ['spec', 'errors', 'domain'],
  lifecycle: ['spec', 'policy', 'errors', 'domain', 'storage'],
};

const fail = (rule: ArchitectureRule, path: string, detail?: string): never => {
  const suffix = detail ? `: ${detail}` : '';
  throw new Error(`[${rule}] ${path}${suffix}`);
};

const normalized = (path: string): string => posix.normalize(path.replaceAll('\\', '/'));

const sourceLayer = (path: string): Layer | undefined => {
  const candidate = /^src\/([^/]+)\//.exec(path)?.[1];
  return layers.find((layer) => layer === candidate);
};

const isRoot = (path: string): boolean => path === 'src/index.ts';

const isBarrel = (path: string): boolean =>
  !isRoot(path) && path.startsWith('src/') && posix.basename(path) === 'index.ts';

const isProductionLeaf = (path: string): boolean =>
  path.startsWith('src/') && path.endsWith('.ts') && !isRoot(path) && !isBarrel(path);

const isTypeOnlyLayer = (path: string): boolean => {
  const layer = sourceLayer(path);
  return layer === 'spec' || layer === 'errors' || layer === 'storage';
};

const hasExportModifier = (modifierFlags: ModifierFlags): boolean =>
  (modifierFlags & ModifierFlags.Export) !== 0;

const bindingNameCount = (name: BindingName): number => {
  if (isIdentifier(name)) return 1;
  if (!isObjectBindingPattern(name) && !isArrayBindingPattern(name)) return 0;

  return name.elements.reduce(
    (count, element) => count + (element.name ? bindingNameCount(element.name) : 0),
    0,
  );
};

const exportedEntityCount = (statements: readonly Statement[]): number =>
  statements.reduce((count, statement) => {
    if (isExportDeclaration(statement)) {
      return (
        count +
        (statement.exportClause && isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.length
          : 2)
      );
    }
    if (isExportAssignment(statement) || isNamespaceExportDeclaration(statement)) return count + 1;
    if (isVariableStatement(statement)) {
      if (!hasExportModifier(statement.modifierFlags)) return count;
      return (
        count +
        statement.declarationList.declarations.reduce(
          (names, declaration) => names + bindingNameCount(declaration.name),
          0,
        )
      );
    }
    if (
      (isClassDeclaration(statement) ||
        isEnumDeclaration(statement) ||
        isFunctionDeclaration(statement) ||
        isInterfaceDeclaration(statement) ||
        isTypeAliasDeclaration(statement)) &&
      hasExportModifier(statement.modifierFlags)
    ) {
      return count + 1;
    }
    return count;
  }, 0);

const moduleSpecifierText = (node: Node | undefined): string | undefined => {
  if (node && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
};

const validateExplicitBarrel = (path: string, sourceFile: SourceFile): void => {
  if (!isBarrel(path)) return;

  for (const statement of sourceFile.statements) {
    if (
      !isExportDeclaration(statement) ||
      !statement.exportClause ||
      !isNamedExports(statement.exportClause) ||
      moduleSpecifierText(statement.moduleSpecifier) === undefined
    ) {
      fail('explicit-barrel-exports', path);
    }

    if (isTypeOnlyLayer(path) && isExportDeclaration(statement) && !statement.isTypeOnly) {
      fail('type-only-layer', path);
    }
  }
};

const validateTypeOnlySyntax = (path: string, sourceFile: SourceFile): void => {
  if (!isTypeOnlyLayer(path)) return;

  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement)) {
      if (statement.importClause?.phaseModifier !== SyntaxKind.TypeKeyword) {
        fail('type-only-layer', path);
      }
      continue;
    }
    if (isImportEqualsDeclaration(statement)) {
      if (!statement.isTypeOnly) fail('type-only-layer', path);
      continue;
    }
    if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) continue;
    if (isExportDeclaration(statement) && statement.isTypeOnly) continue;
    fail('type-only-layer', path);
  }
};

const referenceFromSpecifier = (
  path: string,
  node: Node | undefined,
): ModuleReference | undefined => {
  const specifier = moduleSpecifierText(node);
  if (specifier === undefined) return undefined;
  if (!specifier.startsWith('.')) return { specifier };
  if (!specifier.endsWith('.js')) fail('relative-js-suffix', path, specifier);

  return {
    specifier,
    target: normalized(posix.join(dirname(path), specifier.replace(/\.js$/, '.ts'))),
  };
};

const moduleReferences = (path: string, sourceFile: SourceFile): readonly ModuleReference[] => {
  const references: ModuleReference[] = [];
  const append = (node: Node | undefined): void => {
    const reference = referenceFromSpecifier(path, node);
    if (reference) references.push(reference);
  };

  const visit = (node: Node): void => {
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      append(node.moduleSpecifier);
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      append(node.moduleReference.expression);
    } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (moduleSpecifierText(argument) === undefined) fail('relative-js-suffix', path);
      append(argument);
    } else if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
      append(node.argument.literal);
    }

    node.forEachChild(visit);
  };

  visit(sourceFile);
  return references;
};

const validateExternalReference = (path: string, specifier: string): void => {
  if (!path.startsWith('src/')) return;
  if (specifier.startsWith('@modelcontextprotocol/')) {
    fail('forbidden-mcp-import', path, specifier);
  }
  if (
    specifier === 'orchestrator' ||
    /^@revisium\/(?:agent-|revo-)?orchestrator(?:\/|$)/.test(specifier)
  ) {
    fail('forbidden-orchestrator-import', path, specifier);
  }
  if (path === 'src/index.ts' && (specifier === 'canonicalize' || specifier === 'node:crypto')) {
    return;
  }
  fail('external-import', path, specifier);
};

const validateRelativeReference = (path: string, target: string): void => {
  const fromLayer = sourceLayer(path);
  const targetLayer = sourceLayer(target);

  if (
    path.startsWith('src/') &&
    (/(?:^|\/)(?:test|scripts|dist|coverage)(?:\/|$)/.test(target) ||
      /(?:^|\/)\.architecture-probe-[^/]*(?:\/|$)/.test(target))
  ) {
    fail('forbidden-production-import', path, target);
  }

  if (path.startsWith('test/')) {
    if (
      target.startsWith('src/') &&
      target !== 'src/index.ts' &&
      (!targetLayer || target !== `src/${targetLayer}/index.ts`)
    ) {
      fail('test-private-import', path, target);
    }
    return;
  }

  if (!fromLayer && targetLayer && target === `src/${targetLayer}/index.ts`) return;

  const resolvedFromLayer = fromLayer ?? fail('private-import', path, target);
  const resolvedTargetLayer = targetLayer ?? fail('private-import', path, target);

  if (resolvedFromLayer === resolvedTargetLayer) {
    if (isProductionLeaf(path) && target === `src/${resolvedFromLayer}/index.ts`) {
      fail('own-barrel-import', path, target);
    }
    return;
  }

  if (target !== `src/${resolvedTargetLayer}/index.ts`) {
    fail('private-import', path, target);
  }

  if (!allowedDependencies[resolvedFromLayer].includes(resolvedTargetLayer)) {
    fail('forbidden-layer-import', path, `${resolvedFromLayer} -> ${resolvedTargetLayer}`);
  }
};

const validateReferences = (path: string, references: readonly ModuleReference[]): void => {
  for (const reference of references) {
    if (reference.target) {
      validateRelativeReference(path, reference.target);
    } else {
      validateExternalReference(path, reference.specifier);
    }
  }
};

const validateSourceFile = (path: string, sourceFile: SourceFile): readonly ModuleReference[] => {
  if (path.startsWith('src/') && !isRoot(path) && sourceLayer(path) === undefined) {
    fail('unknown-layer', path);
  }

  validateExplicitBarrel(path, sourceFile);
  validateTypeOnlySyntax(path, sourceFile);

  if (isProductionLeaf(path) && exportedEntityCount(sourceFile.statements) !== 1) {
    fail('one-export-per-leaf', path);
  }

  const references = moduleReferences(path, sourceFile);
  validateReferences(path, references);
  return references;
};

const validateCycles = (
  referencesByPath: ReadonlyMap<string, readonly ModuleReference[]>,
): void => {
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (path: string): void => {
    if (visited.has(path)) return;
    if (visiting.has(path)) fail('type-cycle', path);

    visiting.add(path);
    const references = referencesByPath.get(path) ?? [];
    for (const reference of references) {
      if (reference.target && referencesByPath.has(reference.target)) visit(reference.target);
    }
    visiting.delete(path);
    visited.add(path);
  };

  for (const path of referencesByPath.keys()) visit(path);
};

export const validateModuleStructure = (modules: readonly SourceModule[]): void => {
  if (modules.length === 0) return;

  const virtualRoot = '/module-structure';
  const configPath = `${virtualRoot}/tsconfig.json`;
  const normalizedModules = modules.map((module) => ({ ...module, path: normalized(module.path) }));
  const files: Record<string, string> = {
    [configPath]: JSON.stringify({ files: normalizedModules.map((module) => module.path) }),
  };
  for (const module of normalizedModules) files[`${virtualRoot}/${module.path}`] = module.source;

  const api = new API({ cwd: virtualRoot, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProjects()[0];
    if (!project) throw new Error('TypeScript did not create the module-structure project.');

    const referencesByPath = new Map<string, readonly ModuleReference[]>();
    for (const module of normalizedModules) {
      const sourceFile = project.program.getSourceFile(`${virtualRoot}/${module.path}`);
      if (!sourceFile) throw new Error(`TypeScript did not parse ${module.path}.`);
      referencesByPath.set(module.path, validateSourceFile(module.path, sourceFile));
    }
    validateCycles(referencesByPath);
  } finally {
    api.close();
  }
};
