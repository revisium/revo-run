import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

import { registryRuntimeDependencies } from '../../../scripts/registry-dependency-contract.js';

export const manifestSource = readFileSync(
  new URL('../../../package.json', import.meta.url),
  'utf8',
);
export const lockfileSource = readFileSync(
  new URL('../../../pnpm-lock.yaml', import.meta.url),
  'utf8',
);
export const workspaceSource = readFileSync(
  new URL('../../../pnpm-workspace.yaml', import.meta.url),
  'utf8',
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const mutableRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError('Expected a mapping fixture.');
  }
  return value;
};

export const baseContract = () => ({
  manifest: mutableRecord(JSON.parse(manifestSource)),
  lockfile: mutableRecord(parse(lockfileSource)),
  workspace: mutableRecord(parse(workspaceSource)),
});

export const lockImporterDependency = (
  contract: ReturnType<typeof baseContract>,
  packageName: string,
): Record<string, unknown> => {
  const importers = mutableRecord(contract.lockfile.importers);
  const rootImporter = mutableRecord(importers['.']);
  const dependencies = mutableRecord(rootImporter.dependencies);
  return mutableRecord(dependencies[packageName]);
};

export const dependencyKey = (packageName: keyof typeof registryRuntimeDependencies): string =>
  `${packageName}@${registryRuntimeDependencies[packageName].version}`;
