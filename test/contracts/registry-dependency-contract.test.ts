import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  assertRegistryDependencyContract,
  assertRegistryDependencyFiles,
  registryRuntimeDependencies,
} from '../../scripts/registry-dependency-contract.js';

const rootFile = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const manifestSource = rootFile('package.json');
const lockfileSource = rootFile('pnpm-lock.yaml');
const workspaceSource = rootFile('pnpm-workspace.yaml');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const mutableRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError('Expected a mutable mapping fixture.');
  }
  return value;
};

const baseContract = () => {
  const manifest: unknown = JSON.parse(manifestSource);
  const lockfile: unknown = parse(lockfileSource);
  const workspace: unknown = parse(workspaceSource);
  return {
    manifest: mutableRecord(manifest),
    lockfile: mutableRecord(lockfile),
    workspace: mutableRecord(workspace),
  };
};

const lockImporterDependency = (
  contract: ReturnType<typeof baseContract>,
  packageName: string,
): Record<string, unknown> => {
  const importers = mutableRecord(contract.lockfile['importers']);
  const importer = mutableRecord(importers['.']);
  const dependencies = mutableRecord(importer['dependencies']);
  return mutableRecord(dependencies[packageName]);
};

const isRegistryDependency = (
  packageName: string,
): packageName is keyof typeof registryRuntimeDependencies =>
  Object.hasOwn(registryRuntimeDependencies, packageName);

const dependencyKey = (packageName: string): string => {
  if (!isRegistryDependency(packageName)) {
    throw new Error(`Unknown registry dependency ${packageName}.`);
  }
  const expected = registryRuntimeDependencies[packageName];
  return `${packageName}@${expected.version}`;
};

describe('registry dependency contract', () => {
  it('accepts the checked-in manifest, lockfile, and narrow release-age exclusions', () => {
    expect(() =>
      assertRegistryDependencyFiles({ manifestSource, lockfileSource, workspaceSource }),
    ).not.toThrow();
  });

  it.each(['file:../evil', 'link:../evil', 'workspace:*', 'https://invalid/evil.tgz'])(
    'rejects an exact manifest specifier with a hostile lock resolution %s',
    (resolution) => {
      const contract = baseContract();
      lockImporterDependency(contract, '@revisium/revo-pipeline')['version'] = resolution;

      expect(() => assertRegistryDependencyContract(contract)).toThrow(
        '@revisium/revo-pipeline lockfile importer must resolve the exact registry version.',
      );
    },
  );

  it('rejects a directory resolution even when the expected integrity remains present', () => {
    const contract = baseContract();
    const packages = mutableRecord(contract.lockfile['packages']);
    const pipeline = mutableRecord(packages[dependencyKey('@revisium/revo-pipeline')]);
    pipeline['resolution'] = {
      directory: '../evil',
      integrity: registryRuntimeDependencies['@revisium/revo-pipeline']?.integrity,
    };

    expect(() => assertRegistryDependencyContract(contract)).toThrow(
      '@revisium/revo-pipeline must use the expected npm integrity without a local or tarball resolution.',
    );
  });

  it('rejects a missing or mismatched registry integrity', () => {
    const contract = baseContract();
    const packages = mutableRecord(contract.lockfile['packages']);
    const scripts = mutableRecord(packages[dependencyKey('@revisium/revo-scripts')]);
    scripts['resolution'] = { integrity: 'sha512-hostile' };

    expect(() => assertRegistryDependencyContract(contract)).toThrow(
      '@revisium/revo-scripts must use the expected npm integrity without a local or tarball resolution.',
    );
  });

  it('rejects an altered published snapshot dependency graph', () => {
    const contract = baseContract();
    const snapshots = mutableRecord(contract.lockfile['snapshots']);
    const scripts = mutableRecord(snapshots[dependencyKey('@revisium/revo-scripts')]);
    mutableRecord(scripts['dependencies'])['zod'] = 'file:../evil';

    expect(() => assertRegistryDependencyContract(contract)).toThrow(
      '@revisium/revo-scripts snapshot must match the published dependency graph.',
    );
  });

  it.each([
    [
      'a broad package exemption',
      ['@revisium/revo-pipeline', '@revisium/revo-scripts@0.1.0-alpha.1'],
    ],
    [
      'an unrelated exemption',
      [
        '@revisium/revo-pipeline@0.2.0-alpha.3',
        '@revisium/revo-scripts@0.1.0-alpha.1',
        'untrusted-package@*',
      ],
    ],
  ])('rejects %s in minimumReleaseAgeExclude', (_label, exclusions) => {
    const contract = baseContract();
    contract.workspace['minimumReleaseAgeExclude'] = exclusions;

    expect(() => assertRegistryDependencyContract(contract)).toThrow(
      'minimumReleaseAgeExclude must contain only the two approved exact registry versions.',
    );
  });

  it('rejects workspace resolver overrides', () => {
    const contract = baseContract();
    contract.workspace['overrides'] = { '@revisium/revo-pipeline': 'file:../evil' };

    expect(() => assertRegistryDependencyContract(contract)).toThrow(
      'pnpm-workspace.yaml contains an unsupported resolver surface.',
    );
  });

  it('fails closed for duplicate YAML mapping keys', () => {
    const hostileWorkspace = `${workspaceSource}\nminimumReleaseAgeExclude: []\n`;

    expect(() =>
      assertRegistryDependencyFiles({
        manifestSource,
        lockfileSource,
        workspaceSource: hostileWorkspace,
      }),
    ).toThrow('pnpm-workspace.yaml must be valid YAML without duplicate keys.');
  });
});
