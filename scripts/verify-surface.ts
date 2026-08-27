#!/usr/bin/env node

import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SurfaceCheck {
  readonly roots: readonly string[];
  readonly excluded: ReadonlySet<string>;
  readonly excludedPrefixes: readonly string[];
  readonly pattern: RegExp;
  readonly failure: string;
}

interface SurfaceFailure extends SurfaceCheck {
  readonly findings: readonly string[];
}

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..');

const checks: readonly SurfaceCheck[] = [
  {
    roots: [
      'src',
      'test',
      'docs',
      'README.md',
      'REPOSITORY.md',
      'REVIEW.md',
      'VERIFICATION.md',
      'scripts',
      'examples',
    ],
    excluded: new Set(['scripts/verify-shell.sh', 'scripts/verify-surface.ts']),
    excludedPrefixes: ['docs/adr/superseded/'],
    pattern:
      /ExecutionPlan|RunExecutor|startRun|PipelineInterpreter|NodeEffect|UnknownOutcomeResolution|effect-recovery/iu,
    failure: 'Legacy plan/executor symbols remain in the active RN1 surface.',
  },
  {
    roots: ['src', 'dist'],
    excluded: new Set(),
    excludedPrefixes: [],
    pattern: /Symbol\.for\(|globalThis\[|test[-_ ]?(fault|hook|marker)/iu,
    failure: 'Production source or packed output still contains a test hook or marker.',
  },
  {
    roots: ['src', 'dist'],
    excluded: new Set(),
    excludedPrefixes: [],
    pattern: /WorkflowProbe|reachWorkflowProbe|\.probe(?:\?\.)?\.reach/u,
    failure: 'Production source or packed output still contains a workflow probe.',
  },
  {
    roots: ['src'],
    excluded: new Set(),
    excludedPrefixes: [],
    pattern: /from ['"](?:.*(?:^|\/)test\/|.*test\/support\/)/u,
    failure: 'Production source imports test-only code.',
  },
];

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const scopedPath = (root: string, absolute: string): string => {
  const path = relative(root, absolute).replaceAll('\\', '/');
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) {
    throw new Error(`Required surface scan path escapes its root: ${path}.`);
  }
  return path;
};

const filesystemError = (operation: string, path: string, error: unknown): Error => {
  const code = isNodeError(error) && error.code !== undefined ? error.code : 'UNKNOWN';
  return new Error(`Required surface scan cannot ${operation} ${path}: ${code}.`);
};

const filesUnder = async (root: string, entry: string): Promise<readonly string[]> => {
  const absolute = resolve(root, entry);
  const path = scopedPath(root, absolute);
  let status;
  try {
    status = await lstat(absolute);
  } catch (error) {
    throw filesystemError('inspect', path, error);
  }
  if (status.isSymbolicLink()) {
    throw new Error(`Unsupported symbolic link in required surface scan scope: ${path}.`);
  }
  if (status.isFile()) {
    return [absolute];
  }
  if (!status.isDirectory()) {
    throw new Error(`Unsupported filesystem entry in required surface scan scope: ${path}.`);
  }
  let members;
  try {
    members = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    throw filesystemError('read directory', path, error);
  }
  const children = await Promise.all(
    members.map(async (member): Promise<readonly string[]> => {
      const child = resolve(absolute, member.name);
      return await filesUnder(root, relative(root, child));
    }),
  );
  return children.flat();
};

const isExcluded = (path: string, check: SurfaceCheck): boolean =>
  check.excluded.has(path) || check.excludedPrefixes.some((prefix) => path.startsWith(prefix));

const fileFindings = async (
  root: string,
  file: string,
  check: SurfaceCheck,
): Promise<readonly string[]> => {
  const path = relative(root, file).replaceAll('\\', '/');
  if (isExcluded(path, check)) {
    return [];
  }
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw filesystemError('read file', path, error);
  }
  return source
    .split(/\r?\n/u)
    .flatMap((line, index) => (check.pattern.test(line) ? [`${path}:${index + 1}:${line}`] : []));
};

const findingsFor = async (root: string, check: SurfaceCheck): Promise<readonly string[]> => {
  const rootedFiles = await Promise.all(check.roots.map(async (entry) => filesUnder(root, entry)));
  const findings = await Promise.all(
    rootedFiles.flat().map(async (file) => fileFindings(root, file, check)),
  );
  return findings.flat();
};

export const verifySurface = async (root = repositoryRoot): Promise<readonly SurfaceFailure[]> => {
  const outcomes = await Promise.all(
    checks.map(async (check): Promise<SurfaceFailure | null> => {
      const findings = await findingsFor(root, check);
      return findings.length === 0 ? null : { ...check, findings };
    }),
  );
  return outcomes.filter((outcome): outcome is SurfaceFailure => outcome !== null);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const root = process.argv[2] === undefined ? repositoryRoot : resolve(process.argv[2]);
  try {
    const failures = await verifySurface(root);
    for (const failure of failures) {
      for (const finding of failure.findings) {
        console.error(finding);
      }
      console.error(failure.failure);
    }
    if (failures.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
