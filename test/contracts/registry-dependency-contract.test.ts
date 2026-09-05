import { describe, expect, it } from 'vitest';

import {
  assertRegistryDependencyContract,
  assertRegistryDependencyFiles,
  registryRuntimeDependencies,
} from '../../scripts/registry-dependency-contract.js';
import {
  baseContract,
  dependencyKey,
  lockfileSource,
  lockImporterDependency,
  manifestSource,
  mutableRecord,
  workspaceSource,
} from '../support/package/registry-contract-fixture.js';

describe('registry dependency contract', () => {
  it('pins the generic agent runtime to its published alpha release', () => {
    expect(registryRuntimeDependencies['@revisium/revo-agent-runtime'].version).toBe(
      '0.3.0-alpha.0',
    );
    expect(() =>
      assertRegistryDependencyFiles({
        manifestSource,
        lockfileSource,
        workspaceSource,
      }),
    ).not.toThrow();
  });

  it('accepts one exact root registry resolution', () => {
    const contract = baseContract();
    expect(() => assertRegistryDependencyContract(contract)).not.toThrow();
    const packages = mutableRecord(contract.lockfile.packages);
    expect(
      Object.keys(packages).filter((key) => key.startsWith('@revisium/revo-agent-runtime@')),
    ).toHaveLength(1);
  });

  it.each(['file:../evil', 'link:../evil', 'workspace:*', 'https://invalid/evil.tgz'])(
    'rejects a hostile lock importer resolution %s',
    (resolution) => {
      const contract = baseContract();
      lockImporterDependency(contract, '@revisium/revo-pipeline').version = resolution;
      expect(() => assertRegistryDependencyContract(contract)).toThrow(
        '@revisium/revo-pipeline lockfile importer must resolve the exact registry version.',
      );
    },
  );

  it('rejects a lookalike snapshot version', () => {
    const contract = baseContract();
    const snapshots = mutableRecord(contract.lockfile.snapshots);
    const exactKey = dependencyKey('@revisium/revo-pipeline');
    snapshots[`${exactKey}0`] = snapshots[exactKey];
    delete snapshots[exactKey];
    expect(() => assertRegistryDependencyContract(contract)).toThrow(
      '@revisium/revo-pipeline must have exactly one registry snapshot.',
    );
  });

  it('rejects a directory resolution even with expected integrity', () => {
    const directory = baseContract();
    const packages = mutableRecord(directory.lockfile.packages);
    mutableRecord(packages[dependencyKey('@revisium/revo-pipeline')]).resolution = {
      directory: '../evil',
      integrity: registryRuntimeDependencies['@revisium/revo-pipeline'].integrity,
    };
    expect(() => assertRegistryDependencyContract(directory)).toThrow(
      'must use the expected npm integrity without a local or tarball resolution.',
    );
  });

  it('rejects a mismatched registry integrity', () => {
    const contract = baseContract();
    mutableRecord(
      mutableRecord(contract.lockfile.packages)[dependencyKey('@revisium/revo-scripts')],
    ).resolution = {
      integrity: 'sha512-hostile',
    };
    expect(() => assertRegistryDependencyContract(contract)).toThrow(
      'must use the expected npm integrity without a local or tarball resolution.',
    );
  });

  it('rejects altered snapshot dependencies', () => {
    const snapshot = baseContract();
    mutableRecord(
      mutableRecord(snapshot.lockfile.snapshots)[dependencyKey('@revisium/revo-scripts')],
    ).dependencies = { zod: 'file:../evil' };
    expect(() => assertRegistryDependencyContract(snapshot)).toThrow(
      'snapshot must match the published dependency graph.',
    );
  });

  it('rejects broad or unrelated release-age exemptions', () => {
    const workspace = baseContract();
    workspace.workspace.minimumReleaseAgeExclude = ['@revisium/revo-agent-runtime'];
    expect(() => assertRegistryDependencyContract(workspace)).toThrow(
      'minimumReleaseAgeExclude must contain only approved exact registry versions.',
    );
  });

  it('rejects workspace resolver overrides', () => {
    const workspace = baseContract();
    workspace.workspace = { ...workspace.workspace, overrides: { evil: 'file:../evil' } };
    expect(() => assertRegistryDependencyContract(workspace)).toThrow(
      'pnpm-workspace.yaml contains an unsupported resolver surface.',
    );
  });

  it('fails closed for duplicate YAML mapping keys', () => {
    expect(() =>
      assertRegistryDependencyFiles({
        manifestSource,
        lockfileSource,
        workspaceSource: `${workspaceSource}\nminimumReleaseAgeExclude: []\n`,
      }),
    ).toThrow('pnpm-workspace.yaml must be valid YAML without duplicate keys.');
  });
});
