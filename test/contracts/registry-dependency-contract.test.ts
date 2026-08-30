import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  assertRegistryDependencyContract,
  assertRegistryDependencyFiles,
  registryRuntimeDependencies,
} from '../../scripts/registry-dependency-contract.js';
import { codexContextCase } from '../support/codex-conformance.js';

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
  it('CTX-DEP-EXACT accepts one exact root registry resolution', async () => {
    const context = await codexContextCase('CTX-DEP-EXACT');
    if (
      !isRecord(context.input) ||
      typeof context.input.package !== 'string' ||
      typeof context.input.version !== 'string'
    ) {
      throw new Error('CTX-DEP-EXACT has invalid input.');
    }
    const packageName = context.input.package;
    expect(() =>
      assertRegistryDependencyFiles({ manifestSource, lockfileSource, workspaceSource }),
    ).not.toThrow();
    const contract = baseContract();
    const packages = mutableRecord(contract.lockfile['packages']);
    expect({
      accepted: true,
      resolutionCount: Object.keys(packages).filter((key) => key.startsWith(`${packageName}@`))
        .length,
      importer: 'root',
    }).toStrictEqual(context.expected);
  });

  it('CTX-DEP-REJECT-ALTERNATES rejects every non-approved dependency locator', async () => {
    const context = await codexContextCase('CTX-DEP-REJECT-ALTERNATES');
    if (
      !isRecord(context.input) ||
      !Array.isArray(context.input.variants) ||
      !context.input.variants.every(
        (variant) =>
          isRecord(variant) &&
          typeof variant.id === 'string' &&
          typeof variant.specifier === 'string',
      )
    ) {
      throw new Error('CTX-DEP-REJECT-ALTERNATES has invalid input.');
    }
    const actual = context.input.variants.map((variant) => {
      if (
        !isRecord(variant) ||
        typeof variant.id !== 'string' ||
        typeof variant.specifier !== 'string'
      ) {
        throw new Error('Dependency alternate vector changed after validation.');
      }
      const contract = baseContract();
      mutableRecord(contract.manifest['dependencies'])['@revisium/revo-agent-runtime'] =
        variant.specifier;
      let rejected = false;
      try {
        assertRegistryDependencyContract(contract);
      } catch {
        rejected = true;
      }
      return { id: variant.id, rejected };
    });

    expect(actual).toStrictEqual(context.expected);
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
      [
        '@revisium/revo-agent-runtime',
        '@revisium/revo-pipeline@0.2.0-alpha.3',
        '@revisium/revo-scripts@0.1.0-alpha.1',
      ],
    ],
    [
      'an unrelated exemption',
      [
        '@revisium/revo-agent-runtime@0.1.0-alpha.0',
        '@revisium/revo-pipeline@0.2.0-alpha.3',
        '@revisium/revo-scripts@0.1.0-alpha.1',
        'untrusted-package@*',
      ],
    ],
  ])('rejects %s in minimumReleaseAgeExclude', (_label, exclusions) => {
    const contract = baseContract();
    contract.workspace['minimumReleaseAgeExclude'] = exclusions;

    expect(() => assertRegistryDependencyContract(contract)).toThrow(
      'minimumReleaseAgeExclude must contain only approved exact registry versions.',
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
