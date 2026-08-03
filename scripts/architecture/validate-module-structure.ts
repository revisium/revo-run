import { dirname, posix } from 'node:path';

import {
  ModifierFlags,
  NodeFlags,
  SyntaxKind,
  isArrayBindingPattern,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isExternalModuleReference,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isModuleDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceExportDeclaration,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isPropertyDeclaration,
  isPropertyAccessExpression,
  isQualifiedName,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isVariableStatement,
  isVariableDeclaration,
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
  | 'canonical-json-crypto-import'
  | 'canonical-json-import'
  | 'explicit-barrel-exports'
  | 'external-import'
  | 'forbidden-executor-runtime-import'
  | 'forbidden-layer-import'
  | 'forbidden-mcp-import'
  | 'forbidden-orchestrator-import'
  | 'forbidden-production-import'
  | 'manager-boundary-inference'
  | 'manager-store-reference'
  | 'lifecycle-port-boundary'
  | 'one-export-per-leaf'
  | 'own-barrel-import'
  | 'pipeline-facade-import'
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

type Layer =
  | 'composition'
  | 'domain'
  | 'errors'
  | 'lifecycle'
  | 'manager'
  | 'policy'
  | 'ports'
  | 'spec'
  | 'storage';

const layers: readonly Layer[] = [
  'spec',
  'policy',
  'errors',
  'domain',
  'storage',
  'ports',
  'lifecycle',
  'manager',
  'composition',
];

const allowedDependencies: Readonly<Record<Layer, readonly Layer[]>> = {
  spec: [],
  policy: ['spec'],
  errors: ['spec'],
  domain: ['spec', 'policy', 'errors'],
  storage: ['spec', 'errors', 'domain'],
  ports: ['spec', 'errors'],
  lifecycle: ['spec', 'policy', 'errors', 'domain', 'storage', 'ports'],
  manager: ['spec', 'policy', 'errors', 'ports', 'lifecycle'],
  composition: ['spec', 'errors', 'storage', 'ports', 'lifecycle', 'manager'],
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

const isCuratedEntrypoint = (path: string): boolean =>
  path === 'src/lifecycle/construction.ts' || path === 'src/lifecycle/pipeline-construction.ts';

const isBarrel = (path: string): boolean =>
  !isRoot(path) &&
  path.startsWith('src/') &&
  (posix.basename(path) === 'index.ts' || isCuratedEntrypoint(path));

const isProductionLeaf = (path: string): boolean =>
  path.startsWith('src/') && path.endsWith('.ts') && !isRoot(path) && !isBarrel(path);

const isTypeOnlyLayer = (path: string): boolean => {
  const layer = sourceLayer(path);
  return layer === 'spec' || layer === 'errors' || layer === 'storage' || layer === 'ports';
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

const registerBindingNames = (
  name: BindingName,
  declaration: Node,
  declarations: Map<string, Node>,
): void => {
  if (isIdentifier(name)) {
    declarations.set(name.text, declaration);
    return;
  }
  if (!isObjectBindingPattern(name) && !isArrayBindingPattern(name)) return;
  for (const element of name.elements) {
    if (element.name) registerBindingNames(element.name, declaration, declarations);
  }
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

const isTypeOnlyStatement = (statement: Statement): boolean => {
  if (isImportDeclaration(statement)) {
    return statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword;
  }
  if (isImportEqualsDeclaration(statement)) return statement.isTypeOnly;
  if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) return true;
  return isExportDeclaration(statement) && statement.isTypeOnly;
};

const validateTypeOnlySyntax = (path: string, sourceFile: SourceFile): void => {
  if (!isTypeOnlyLayer(path)) return;
  if (sourceFile.statements.some((statement) => !isTypeOnlyStatement(statement))) {
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
  if (specifier === 'canonicalize') {
    if (path === 'src/policy/canonical-json/canonicalize-json.ts') return;
    fail('canonical-json-import', path, specifier);
  }
  if (specifier === 'node:crypto') {
    if (path === 'src/policy/canonical-json/digest-canonical-json.ts') return;
    fail('canonical-json-crypto-import', path, specifier);
  }
  if (specifier.startsWith('@modelcontextprotocol/')) {
    fail('forbidden-mcp-import', path, specifier);
  }
  if (
    specifier === 'orchestrator' ||
    /^@revisium\/(?:agent-|revo-)?orchestrator(?:\/|$)/.test(specifier)
  ) {
    fail('forbidden-orchestrator-import', path, specifier);
  }
  if (/^@revisium\/(?:revo-agent-runtime|revo-scripts)(?:\/|$)/.test(specifier)) {
    fail('forbidden-executor-runtime-import', path, specifier);
  }
  if (path.startsWith('src/lifecycle/pipeline/') && specifier === '@revisium/revo-pipeline') {
    return;
  }
  if (path.startsWith('src/composition/workflow/') && specifier === '@dbos-inc/dbos-sdk') {
    return;
  }
  fail('external-import', path, specifier);
};

const isForbiddenProductionTarget = (target: string): boolean =>
  /(?:^|\/)(?:test|scripts|dist|coverage)(?:\/|$)/.test(target) ||
  /(?:^|\/)\.architecture-probe-[^/]*(?:\/|$)/.test(target);

const validateTestReference = (path: string, target: string, targetLayer?: Layer): void => {
  if (!target.startsWith('src/') || target === 'src/index.ts') return;
  if (targetLayer && (target === `src/${targetLayer}/index.ts` || isCuratedEntrypoint(target)))
    return;
  fail('test-private-import', path, target);
};

const validateSameLayerReference = (path: string, target: string, layer: Layer): void => {
  if (path === 'src/lifecycle/index.ts' && target.startsWith('src/lifecycle/pipeline/')) {
    fail('pipeline-facade-import', path, target);
  }
  if (isProductionLeaf(path) && target === `src/${layer}/index.ts`) {
    fail('own-barrel-import', path, target);
  }
};

const validateCrossLayerReference = (
  path: string,
  target: string,
  fromLayer: Layer,
  targetLayer: Layer,
): void => {
  if (target !== `src/${targetLayer}/index.ts`) fail('private-import', path, target);
  if (!allowedDependencies[fromLayer].includes(targetLayer)) {
    fail('forbidden-layer-import', path, `${fromLayer} -> ${targetLayer}`);
  }
};

const validateRelativeReference = (path: string, target: string): void => {
  const targetLayer = sourceLayer(target);
  if (path.startsWith('src/lifecycle/') && target.startsWith('src/provider/')) {
    fail('lifecycle-port-boundary', path, 'provider type leak');
  }
  if (path.startsWith('src/') && isForbiddenProductionTarget(target)) {
    fail('forbidden-production-import', path, target);
  }
  if (path.startsWith('test/')) return validateTestReference(path, target, targetLayer);
  if (isRoot(path) && targetLayer && target === `src/${targetLayer}/index.ts`) {
    if (!['composition', 'spec', 'errors'].includes(targetLayer)) {
      fail('forbidden-layer-import', path, `root -> ${targetLayer}`);
    }
    return;
  }
  const fromLayer = sourceLayer(path) ?? fail('private-import', path, target);
  const resolvedTarget = targetLayer ?? fail('private-import', path, target);
  if (
    fromLayer === 'composition' &&
    (target === 'src/lifecycle/construction.ts' ||
      target === 'src/lifecycle/pipeline-construction.ts')
  )
    return;
  if (fromLayer === resolvedTarget) return validateSameLayerReference(path, target, fromLayer);
  validateCrossLayerReference(path, target, fromLayer, resolvedTarget);
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

const validateManagerBoundaryInference = (path: string, sourceFile: SourceFile): void => {
  if (sourceLayer(path) !== 'manager') return;

  const visit = (node: Node): void => {
    if (isIdentifier(node) && node.text === 'RunStore') {
      fail('manager-store-reference', path, 'RunStore');
    }
    if (
      isTypeReferenceNode(node) &&
      isIdentifier(node.typeName) &&
      (node.typeName.text === 'Parameters' || node.typeName.text === 'ReturnType')
    ) {
      fail('manager-boundary-inference', path, node.typeName.text);
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
};

const validateLifecyclePortBoundary = (path: string, sourceFile: SourceFile): void => {
  const constructionFiles = new Set([
    'src/lifecycle/construction.ts',
    'src/lifecycle/create-run-lifecycle.ts',
    'src/lifecycle/run-lifecycle-dependencies.ts',
  ]);
  const operationalFiles = new Set(['src/lifecycle/index.ts', 'src/lifecycle/run-lifecycle.ts']);
  if (operationalFiles.has(path)) {
    const visitOperational = (node: Node): void => {
      if (
        isTypeReferenceNode(node) &&
        isIdentifier(node.typeName) &&
        (node.typeName.text === 'ResolvedExecutor' || node.typeName.text === 'ExecutorResolution')
      ) {
        fail('lifecycle-port-boundary', path, 'operational facade port leak');
      }
      if (
        isImportDeclaration(node) &&
        referenceFromSpecifier(path, node.moduleSpecifier)?.target === 'src/ports/index.ts'
      ) {
        fail('lifecycle-port-boundary', path, 'operational facade port leak');
      }
      node.forEachChild(visitOperational);
    };
    visitOperational(sourceFile);
  }
  if (!constructionFiles.has(path)) return;
  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement)) continue;
    const reference = referenceFromSpecifier(path, statement.moduleSpecifier);
    if (reference?.target !== 'src/ports/index.ts') continue;
    const imports = statement.importClause?.namedBindings;
    const importedName =
      imports && isNamedImports(imports)
        ? (imports.elements[0]?.propertyName?.text ?? imports.elements[0]?.name.text)
        : undefined;
    if (
      imports === undefined ||
      !isNamedImports(imports) ||
      imports.elements.length !== 1 ||
      importedName !== 'ExecutorResolver'
    ) {
      fail('lifecycle-port-boundary', path, 'construction may import only ExecutorResolver');
    }
  }
  const visit = (node: Node): void => {
    if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
      const reference = referenceFromSpecifier(path, node.argument.literal);
      if (
        reference?.target === 'src/ports/index.ts' &&
        (!node.qualifier ||
          !isIdentifier(node.qualifier) ||
          node.qualifier.text !== 'ExecutorResolver')
      ) {
        fail('lifecycle-port-boundary', path, 'construction import type is not ExecutorResolver');
      }
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const reference = referenceFromSpecifier(path, node.arguments[0]);
      if (reference?.target === 'src/ports/index.ts') {
        fail('lifecycle-port-boundary', path, 'construction dynamic port import');
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
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
  validateManagerBoundaryInference(path, sourceFile);
  validateLifecyclePortBoundary(path, sourceFile);
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

const validateOperationalDeclarations = (
  referencesByPath: ReadonlyMap<string, readonly ModuleReference[]>,
  sourceByPath: ReadonlyMap<string, SourceFile>,
): void => {
  const pending = ['src/lifecycle/index.ts'];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const source = sourceByPath.get(path);
    if (!source) continue;
    for (const reference of referencesByPath.get(path) ?? []) {
      const target = reference.target;
      if (
        target === 'src/ports/index.ts' ||
        target === 'src/lifecycle/construction.ts' ||
        target === 'src/lifecycle/create-run-lifecycle.ts' ||
        target === 'src/lifecycle/run-lifecycle-dependencies.ts' ||
        target?.startsWith('src/storage/') ||
        target?.startsWith('src/domain/') ||
        target?.startsWith('src/lifecycle/pipeline/') ||
        target?.startsWith('src/provider/')
      ) {
        fail('lifecycle-port-boundary', path, 'reachable operational boundary leak');
      }
      if (target?.startsWith('src/lifecycle/')) pending.push(target);
    }
  }
};

interface ConstructionSymbols {
  readonly constDeclarations: ReadonlySet<Node>;
  readonly imported: ReadonlyMap<string, string>;
  readonly locals: ReadonlyMap<string, Node>;
}

const indexImport = (path: string, statement: Statement, imported: Map<string, string>): void => {
  if (
    isImportEqualsDeclaration(statement) &&
    isExternalModuleReference(statement.moduleReference)
  ) {
    const target = referenceFromSpecifier(path, statement.moduleReference.expression)?.target;
    if (target) imported.set(statement.name.text, target);
    return;
  }
  if (!isImportDeclaration(statement)) return;
  const target = referenceFromSpecifier(path, statement.moduleSpecifier)?.target;
  if (!target) return;
  const clause = statement.importClause;
  if (clause?.name) imported.set(clause.name.text, target);
  const bindings = clause?.namedBindings;
  if (bindings && isNamedImports(bindings)) {
    for (const element of bindings.elements) imported.set(element.name.text, target);
  } else if (bindings && 'name' in bindings && isIdentifier(bindings.name)) {
    imported.set(bindings.name.text, target);
  }
};

const indexLocal = (
  statement: Statement,
  locals: Map<string, Node>,
  constDeclarations: Set<Node>,
): void => {
  if (
    (isInterfaceDeclaration(statement) ||
      isTypeAliasDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isFunctionDeclaration(statement)) &&
    statement.name
  ) {
    locals.set(statement.name.text, statement);
  }
  if (!isVariableStatement(statement)) return;
  for (const declaration of statement.declarationList.declarations) {
    registerBindingNames(declaration.name, declaration, locals);
    if ((statement.declarationList.flags & NodeFlags.Const) !== 0) {
      constDeclarations.add(declaration);
    }
  }
};

const constructionSymbols = (path: string, sourceFile: SourceFile): ConstructionSymbols => {
  const constDeclarations = new Set<Node>();
  const imported = new Map<string, string>();
  const locals = new Map<string, Node>();
  for (const statement of sourceFile.statements) {
    indexImport(path, statement, imported);
    indexLocal(statement, locals, constDeclarations);
  }
  return { constDeclarations, imported, locals };
};

const declarationBounds = (declaration: Node): ReadonlySet<string> => {
  if (
    isFunctionDeclaration(declaration) ||
    isInterfaceDeclaration(declaration) ||
    isTypeAliasDeclaration(declaration)
  ) {
    return typeParameterNames(declaration.typeParameters);
  }
  if (
    isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (isArrowFunction(declaration.initializer) || isFunctionExpression(declaration.initializer))
  ) {
    return typeParameterNames(declaration.initializer.typeParameters);
  }
  return new Set();
};

const isNameBearingTypeNode = (node: Node): boolean =>
  node.kind === SyntaxKind.TypeParameter ||
  node.kind === SyntaxKind.NamedTupleMember ||
  node.kind === SyntaxKind.TypePredicate;

class ConstructionTargetCollector {
  readonly targets = new Set<string>();
  private readonly visited = new Set<Node>();

  constructor(
    private readonly path: string,
    private readonly symbols: ConstructionSymbols,
  ) {}

  collect(node: Node | undefined, bound: ReadonlySet<string> = new Set()): void {
    if (!node || this.visited.has(node) || node.kind === SyntaxKind.Block) return;
    this.visited.add(node);
    if (this.collectDeclaration(node)) return;
    if (isPropertySurface(node)) return this.collectProperty(node, bound);
    if (isTypeFunctionSurface(node)) return this.collectFunctionType(node, bound);
    if (node.kind === SyntaxKind.MappedType) return this.collectMapped(node, bound);
    if (node.kind === SyntaxKind.ConditionalType) return this.collectConditional(node, bound);
    if (isQualifiedName(node)) return this.collect(node.left, bound);
    if (isNameBearingTypeNode(node)) return this.collectSkippingName(node, bound);
    if (this.collectReference(node, bound)) return;
    node.forEachChild((child) => this.collect(child, bound));
  }

  private collectReference(node: Node, bound: ReadonlySet<string>): boolean {
    if (isIdentifier(node)) {
      this.collectIdentifier(node, bound);
      return true;
    }
    if (!isImportTypeNode(node) || !isLiteralTypeNode(node.argument)) return false;
    this.collectImportType(node, bound);
    return true;
  }

  private collectDeclaration(node: Node): boolean {
    if (
      !isVariableDeclaration(node) &&
      !isFunctionDeclaration(node) &&
      !isClassDeclaration(node) &&
      !isInterfaceDeclaration(node) &&
      !isTypeAliasDeclaration(node)
    ) {
      return false;
    }
    if (isVariableDeclaration(node) && !this.symbols.constDeclarations.has(node)) {
      fail('lifecycle-port-boundary', this.path, 'construction declaration non-const variable');
    }
    const bound = declarationBounds(node);
    walkDeclarationSurface(node, {
      inferred: (kind) =>
        fail('lifecycle-port-boundary', this.path, `construction declaration inferred ${kind}`),
      type: (typeNode) => {
        validateTypeSyntax(typeNode, (kind) =>
          fail('lifecycle-port-boundary', this.path, `construction declaration inferred ${kind}`),
        );
        this.collect(typeNode, bound);
      },
    });
    return true;
  }

  private collectSkippingName(node: Node, bound: ReadonlySet<string>): void {
    let skipped = false;
    node.forEachChild((child) => {
      if (!skipped && isIdentifier(child)) {
        skipped = true;
        return;
      }
      this.collect(child, bound);
    });
  }

  private collectProperty(node: NamedTypedSurfaceNode, bound: ReadonlySet<string>): void {
    if (!isIdentifier(node.name)) {
      fail('lifecycle-port-boundary', this.path, 'computed public member name');
    }
    this.collect(node.type, bound);
  }

  private collectFunctionType(node: FunctionSurfaceNode, bound: ReadonlySet<string>): void {
    const nested = extendedTypeScope(bound, typeParameterNames(node.typeParameters));
    for (const parameter of node.typeParameters ?? []) this.collect(parameter, nested);
    for (const parameter of node.parameters) this.collect(parameter.type, nested);
    this.collect(node.type, nested);
  }

  private collectMapped(node: Node, bound: ReadonlySet<string>): void {
    const children = childNodes(node);
    const parameter = children[0];
    this.collect(parameter, bound);
    const names = parameter ? typeParameterNames([parameter]) : new Set<string>();
    const nested = extendedTypeScope(bound, names);
    for (const child of children.slice(1)) this.collect(child, nested);
  }

  private collectConditional(node: Node, bound: ReadonlySet<string>): void {
    const children = childNodes(node);
    const inferIndex = children.findIndex((child) => inferTypeNames(child).size > 0);
    if (inferIndex < 0) {
      for (const child of children) this.collect(child, bound);
      return;
    }
    const inferred = children[inferIndex]!;
    visitInferConstraints(inferred, (constraint) => this.collect(constraint, bound));
    const nested = extendedTypeScope(bound, inferTypeNames(inferred));
    children.forEach((child, index) =>
      this.collect(child, index === inferIndex + 1 ? nested : bound),
    );
  }

  private collectIdentifier(
    node: Node & { readonly text: string },
    bound: ReadonlySet<string>,
  ): void {
    if (bound.has(node.text)) return;
    const target = this.symbols.imported.get(node.text);
    if (target) this.targets.add(target);
    this.collect(this.symbols.locals.get(node.text));
  }

  private collectImportType(
    node: Node & { readonly argument: Node },
    bound: ReadonlySet<string>,
  ): void {
    const argument = isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
    const target = referenceFromSpecifier(this.path, argument)?.target;
    if (target) this.targets.add(target);
    for (const child of childNodes(node)) {
      if (child !== node.argument && !isIdentifier(child) && !isQualifiedName(child)) {
        this.collect(child, bound);
      }
    }
  }
}

const childNodes = (node: Node): readonly Node[] => {
  const children: Node[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  return children;
};

const collectExportDeclaration = (
  path: string,
  statement: ReturnType<typeof exportDeclarationCast>,
  collector: ConstructionTargetCollector,
): void => {
  const target = referenceFromSpecifier(path, statement.moduleSpecifier)?.target;
  if (target) collector.targets.add(target);
  if (
    statement.moduleSpecifier ||
    !statement.exportClause ||
    !isNamedExports(statement.exportClause)
  ) {
    return;
  }
  for (const element of statement.exportClause.elements) {
    collector.collect(element.propertyName ?? element.name);
  }
};

const exportDeclarationCast = (node: Node) => {
  if (!isExportDeclaration(node)) throw new Error('Expected export declaration.');
  return node;
};

const collectExportedConstruction = (
  path: string,
  statement: Statement,
  collector: ConstructionTargetCollector,
): void => {
  if (isExportDeclaration(statement)) return collectExportDeclaration(path, statement, collector);
  if (isExportAssignment(statement)) return collector.collect(statement.expression);
  if (
    (isInterfaceDeclaration(statement) ||
      isTypeAliasDeclaration(statement) ||
      isFunctionDeclaration(statement) ||
      isClassDeclaration(statement)) &&
    hasExportModifier(statement.modifierFlags)
  ) {
    return collector.collect(statement);
  }
  if (isVariableStatement(statement) && hasExportModifier(statement.modifierFlags)) {
    for (const declaration of statement.declarationList.declarations)
      collector.collect(declaration);
  }
};

const constructionDeclarationTargets = (
  path: string,
  sourceFile: SourceFile,
): readonly string[] => {
  const collector = new ConstructionTargetCollector(path, constructionSymbols(path, sourceFile));
  for (const statement of sourceFile.statements)
    collectExportedConstruction(path, statement, collector);
  return [...collector.targets];
};

interface DeclarationSurfaceCallbacks {
  readonly inferred: (kind: string) => void;
  readonly type: (node: Node) => void;
}

type FunctionSurfaceNode = Node & {
  readonly name?: Node;
  readonly parameters: readonly {
    readonly dotDotDotToken?: Node;
    readonly name: BindingName;
    readonly type?: Node;
  }[];
  readonly type?: Node;
  readonly typeParameters?: readonly Node[];
};

type NamedTypedSurfaceNode = Node & {
  readonly name: Node;
  readonly type?: Node;
};

const isPropertySurface = (node: Node): node is NamedTypedSurfaceNode =>
  isPropertyDeclaration(node) || node.kind === SyntaxKind.PropertySignature;

const isTypeFunctionSurface = (node: Node): node is FunctionSurfaceNode =>
  node.kind === SyntaxKind.FunctionType ||
  node.kind === SyntaxKind.ConstructorType ||
  node.kind === SyntaxKind.CallSignature ||
  node.kind === SyntaxKind.ConstructSignature ||
  node.kind === SyntaxKind.MethodSignature;

type TypeParameterSurfaceNode = Node & {
  readonly constraint?: Node;
  readonly name: Node;
};

type InferTypeSurfaceNode = Node & {
  readonly typeParameter: TypeParameterSurfaceNode;
};

const isTypeParameterSurface = (node: Node): node is TypeParameterSurfaceNode =>
  node.kind === SyntaxKind.TypeParameter;

const isInferTypeSurface = (node: Node): node is InferTypeSurfaceNode =>
  node.kind === SyntaxKind.InferType;

const typeParameterNames = (parameters: readonly Node[] | undefined): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const parameter of parameters ?? []) {
    if (isTypeParameterSurface(parameter) && isIdentifier(parameter.name)) {
      names.add(parameter.name.text);
    }
  }
  return names;
};

const extendedTypeScope = (
  bound: ReadonlySet<string>,
  additions: ReadonlySet<string>,
): ReadonlySet<string> => new Set([...bound, ...additions]);

const inferTypeNames = (node: Node): ReadonlySet<string> => {
  const names = new Set<string>();
  const visit = (child: Node): void => {
    if (isInferTypeSurface(child)) {
      if (isIdentifier(child.typeParameter.name)) names.add(child.typeParameter.name.text);
      return;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return names;
};

const visitInferConstraints = (node: Node, visitConstraint: (node: Node) => void): void => {
  const visit = (child: Node): void => {
    if (isInferTypeSurface(child)) {
      if (child.typeParameter.constraint) visitConstraint(child.typeParameter.constraint);
      return;
    }
    child.forEachChild(visit);
  };
  visit(node);
};

const validateTypeSyntax = (
  node: Node,
  inferred: DeclarationSurfaceCallbacks['inferred'],
): void => {
  if (node.kind === SyntaxKind.TypeQuery) inferred('type query');
  if (isTypeFunctionSurface(node)) {
    for (const parameter of node.parameters) {
      if (!isIdentifier(parameter.name)) {
        inferred('non-identifier function type parameter');
      }
      if (!parameter.type) inferred('function type parameter');
    }
  }
  node.forEachChild((child) => validateTypeSyntax(child, inferred));
};

const walkFunctionSurface = (
  declaration: FunctionSurfaceNode,
  callbacks: DeclarationSurfaceCallbacks,
  requiresReturn: boolean,
): void => {
  for (const parameter of declaration.typeParameters ?? []) {
    callbacks.type(parameter);
  }
  for (const parameter of declaration.parameters) {
    if (!isIdentifier(parameter.name)) {
      callbacks.inferred('non-identifier parameter');
    }
    if (!parameter.type) callbacks.inferred('parameter');
    else callbacks.type(parameter.type);
  }
  if (requiresReturn && !declaration.type) callbacks.inferred('function return');
  if (declaration.type) callbacks.type(declaration.type);
};

const walkVariableSurface = (
  declaration: ReturnType<typeof variableDeclarationCast>,
  callbacks: DeclarationSurfaceCallbacks,
): void => {
  if (!isIdentifier(declaration.name)) return callbacks.inferred('destructured exported binding');
  if (declaration.type) return callbacks.type(declaration.type);
  const initializer = declaration.initializer;
  if (initializer && (isArrowFunction(initializer) || isFunctionExpression(initializer))) {
    return walkFunctionSurface(initializer, callbacks, true);
  }
  callbacks.inferred('exported value');
};

const variableDeclarationCast = (node: Node) => {
  if (!isVariableDeclaration(node)) throw new Error('Expected variable declaration.');
  return node;
};

const walkInterfaceSurface = (
  declaration: ReturnType<typeof interfaceDeclarationCast>,
  callbacks: DeclarationSurfaceCallbacks,
): void => {
  for (const parameter of declaration.typeParameters ?? []) {
    callbacks.type(parameter);
  }
  for (const heritage of declaration.heritageClauses ?? []) callbacks.type(heritage);
  for (const member of declaration.members) {
    if (!isPropertySurface(member)) {
      callbacks.inferred('non-data interface member');
      continue;
    }
    if (!isIdentifier(member.name)) callbacks.inferred('computed public member name');
    if (!member.type) callbacks.inferred('interface property');
    else callbacks.type(member.type);
  }
};

const interfaceDeclarationCast = (node: Node) => {
  if (!isInterfaceDeclaration(node)) throw new Error('Expected interface declaration.');
  return node;
};

const walkDeclarationSurface = (
  declaration: Node,
  callbacks: DeclarationSurfaceCallbacks,
): void => {
  if (isVariableDeclaration(declaration)) return walkVariableSurface(declaration, callbacks);
  if (isFunctionDeclaration(declaration)) {
    if (!declaration.name) callbacks.inferred('anonymous function');
    return walkFunctionSurface(declaration, callbacks, true);
  }
  if (isTypeAliasDeclaration(declaration)) {
    for (const parameter of declaration.typeParameters ?? []) callbacks.type(parameter);
    return callbacks.type(declaration.type);
  }
  if (isInterfaceDeclaration(declaration)) return walkInterfaceSurface(declaration, callbacks);
  if (
    isClassDeclaration(declaration) ||
    isEnumDeclaration(declaration) ||
    isModuleDeclaration(declaration)
  ) {
    callbacks.inferred('disallowed public declaration');
  }
};

const validateExplicitConstructionSurface = (path: string, sourceFile: SourceFile): void => {
  const hasDefault = sourceFile.statements.some((statement) => {
    if (isExportAssignment(statement)) return true;
    if (
      'modifierFlags' in statement &&
      typeof statement.modifierFlags === 'number' &&
      (statement.modifierFlags & ModifierFlags.Default) !== 0
    ) {
      return true;
    }
    return (
      isExportDeclaration(statement) &&
      statement.exportClause &&
      isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) => element.name.text === 'default')
    );
  });
  if (hasDefault) {
    fail('lifecycle-port-boundary', path, 'construction declaration default export');
  }
};

const validateResolverBinding = (path: string, node: Node): void => {
  if (!isImportDeclaration(node) && !isExportDeclaration(node)) return;
  if (referenceFromSpecifier(path, node.moduleSpecifier)?.target !== 'src/ports/index.ts') return;
  const bindings = isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
  const elements =
    bindings && (isNamedImports(bindings) || isNamedExports(bindings)) ? bindings.elements : [];
  const imported = elements[0]?.propertyName?.text ?? elements[0]?.name.text;
  if (elements.length !== 1 || imported !== 'ExecutorResolver') {
    fail('lifecycle-port-boundary', path, 'construction graph non-resolver port');
  }
};

const validateResolverSpecialImport = (path: string, node: Node): void => {
  if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
    if (
      referenceFromSpecifier(path, node.moduleReference.expression)?.target === 'src/ports/index.ts'
    ) {
      fail('lifecycle-port-boundary', path, 'construction graph import-equals port');
    }
    return;
  }
  if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
    const reference = referenceFromSpecifier(path, node.argument.literal);
    const valid =
      node.qualifier && isIdentifier(node.qualifier) && node.qualifier.text === 'ExecutorResolver';
    if (reference?.target === 'src/ports/index.ts' && !valid) {
      fail('lifecycle-port-boundary', path, 'construction graph inline non-resolver port');
    }
    return;
  }
  if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
    if (referenceFromSpecifier(path, node.arguments[0])?.target === 'src/ports/index.ts') {
      fail('lifecycle-port-boundary', path, 'construction graph dynamic port import');
    }
  }
};

const validateResolverOnlyReferences = (path: string, sourceFile: SourceFile): void => {
  const visit = (node: Node): void => {
    validateResolverBinding(path, node);
    validateResolverSpecialImport(path, node);
    node.forEachChild(visit);
  };
  visit(sourceFile);
};

class StoreBoundaryValidator {
  private readonly storageNamespaces = new Set<string>();

  constructor(private readonly path: string) {}

  validate(sourceFile: SourceFile): void {
    for (const statement of sourceFile.statements) this.collectNamespace(statement);
    this.visit(sourceFile);
  }

  private rejectSymbol(symbol: string): void {
    if (symbol !== 'RunStore') {
      fail('lifecycle-port-boundary', this.path, 'construction declaration non-RunStore storage');
    }
  }

  private collectNamespace(statement: Statement): void {
    if (isImportDeclaration(statement)) {
      const reference = referenceFromSpecifier(this.path, statement.moduleSpecifier);
      const bindings = statement.importClause?.namedBindings;
      if (reference?.target === 'src/storage/index.ts' && bindings && !isNamedImports(bindings)) {
        this.storageNamespaces.add(bindings.name.text);
      }
      return;
    }
    if (
      isImportEqualsDeclaration(statement) &&
      isExternalModuleReference(statement.moduleReference) &&
      referenceFromSpecifier(this.path, statement.moduleReference.expression)?.target ===
        'src/storage/index.ts'
    ) {
      this.storageNamespaces.add(statement.name.text);
    }
  }

  private visit(node: Node): void {
    if (this.visitBinding(node)) return node.forEachChild((child) => this.visit(child));
    this.visitSpecial(node);
    node.forEachChild((child) => this.visit(child));
  }

  private visitBinding(node: Node): boolean {
    if (!isImportDeclaration(node) && !isExportDeclaration(node)) return false;
    const reference = referenceFromSpecifier(this.path, node.moduleSpecifier);
    if (reference?.target !== 'src/storage/index.ts') return true;
    const clause = isImportDeclaration(node) ? node.importClause : undefined;
    const bindings = isImportDeclaration(node)
      ? node.importClause?.namedBindings
      : node.exportClause;
    if (clause?.name) this.rejectSymbol('default');
    if (bindings && (isNamedImports(bindings) || isNamedExports(bindings))) {
      for (const element of bindings.elements) {
        this.rejectSymbol(element.propertyName?.text ?? element.name.text);
      }
    } else if (bindings && 'name' in bindings) {
      this.storageNamespaces.add(bindings.name.text);
    }
    return true;
  }

  private visitSpecial(node: Node): void {
    if (isImportEqualsDeclaration(node)) return this.visitImportEquals(node);
    if (isImportTypeNode(node) && isLiteralTypeNode(node.argument))
      return this.visitImportType(node);
    if (
      isQualifiedName(node) &&
      isIdentifier(node.left) &&
      this.storageNamespaces.has(node.left.text)
    ) {
      return this.rejectSymbol(node.right.text);
    }
    if (
      isPropertyAccessExpression(node) &&
      isIdentifier(node.expression) &&
      this.storageNamespaces.has(node.expression.text)
    ) {
      this.rejectSymbol(node.name.text);
    }
  }

  private visitImportEquals(node: ReturnType<typeof importEqualsCast>): void {
    const reference = isExternalModuleReference(node.moduleReference)
      ? referenceFromSpecifier(this.path, node.moduleReference.expression)
      : undefined;
    if (reference?.target === 'src/storage/index.ts') this.storageNamespaces.add(node.name.text);
  }

  private visitImportType(
    node: Node & { readonly argument: Node; readonly qualifier?: Node },
  ): void {
    const argument = isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
    const reference = referenceFromSpecifier(this.path, argument);
    if (
      reference?.target === 'src/storage/index.ts' &&
      (!node.qualifier || !isIdentifier(node.qualifier) || node.qualifier.text !== 'RunStore')
    ) {
      fail('lifecycle-port-boundary', this.path, 'construction declaration non-RunStore storage');
    }
  }
}

const importEqualsCast = (node: Node) => {
  if (!isImportEqualsDeclaration(node)) throw new Error('Expected import-equals declaration.');
  return node;
};

const validateStoreBoundaryReference = (path: string, sourceFile: SourceFile): void => {
  if (path !== 'src/lifecycle/run-lifecycle-dependencies.ts') {
    fail('lifecycle-port-boundary', path, 'construction declaration storage leak');
  }
  new StoreBoundaryValidator(path).validate(sourceFile);
};

const queueConstructionTarget = (
  path: string,
  source: SourceFile,
  target: string,
  pending: string[],
): void => {
  if (target === 'src/ports/index.ts') return validateResolverOnlyReferences(path, source);
  if (target.startsWith('src/storage/')) validateStoreBoundaryReference(path, source);
  const forbidden =
    (target.startsWith('src/storage/') && path !== 'src/lifecycle/run-lifecycle-dependencies.ts') ||
    ['domain', 'lifecycle/pipeline', 'provider', 'manager', 'composition'].some((segment) =>
      target.startsWith(`src/${segment}/`),
    );
  if (forbidden) fail('lifecycle-port-boundary', path, 'construction graph layer leak');
  if (target.startsWith('src/storage/') || target === 'src/lifecycle/run-lifecycle.ts') return;
  if (target.startsWith('src/lifecycle/')) pending.push(target);
};

const validateConstructionPath = (path: string, source: SourceFile, pending: string[]): void => {
  if (path !== 'src/lifecycle/run-lifecycle.ts') validateExplicitConstructionSurface(path, source);
  for (const target of constructionDeclarationTargets(path, source)) {
    queueConstructionTarget(path, source, target, pending);
  }
};

const validateConstructionDeclarations = (sourceByPath: ReadonlyMap<string, SourceFile>): void => {
  const pending = ['src/lifecycle/construction.ts'];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const source = sourceByPath.get(path);
    if (!source) continue;
    validateConstructionPath(path, source, pending);
  }
};

export const validateModuleStructure = (modules: readonly SourceModule[]): void => {
  if (modules.length === 0) return;

  const parserRoot = '/module-structure';
  const parserConfigPath = `${parserRoot}/tsconfig.json`;
  const normalizedModules = modules.map((module) => ({ ...module, path: normalized(module.path) }));
  const files: Record<string, string> = {
    [parserConfigPath]: JSON.stringify({ files: normalizedModules.map((module) => module.path) }),
  };
  for (const module of normalizedModules) files[`${parserRoot}/${module.path}`] = module.source;
  const api = new API({ cwd: parserRoot, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [parserConfigPath] });
    const project = snapshot.getProjects()[0];
    if (!project) throw new Error('TypeScript did not create the module-structure project.');

    const referencesByPath = new Map<string, readonly ModuleReference[]>();
    const sourceByPath = new Map<string, SourceFile>();
    for (const module of normalizedModules) {
      const sourceFile = project.program.getSourceFile(`${parserRoot}/${module.path}`);
      if (!sourceFile) throw new Error(`TypeScript did not parse ${module.path}.`);
      sourceByPath.set(module.path, sourceFile);
      referencesByPath.set(module.path, validateSourceFile(module.path, sourceFile));
    }
    validateOperationalDeclarations(referencesByPath, sourceByPath);
    validateConstructionDeclarations(sourceByPath);
    validateCycles(referencesByPath);
  } finally {
    api.close();
  }
};
