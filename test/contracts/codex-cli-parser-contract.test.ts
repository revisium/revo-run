import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type CodexCliProbeSpawn,
  probeInstalledCodexParser,
} from '../support/codex-runtime/codex-cli-parser-smoke.js';
import {
  codexResultSchema,
  createFakeCodexFixture,
  removeFakeCodexFixture,
  type FakeCodexFixture,
} from '../support/codex-runtime/fake-codex.js';

const fixtures: FakeCodexFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(removeFakeCodexFixture));
  vi.unstubAllEnvs();
});

const fixture = async (): Promise<
  Readonly<{ value: FakeCodexFixture; arguments_: readonly string[] }>
> => {
  const value = await createFakeCodexFixture('success');
  fixtures.push(value);
  const schemaPath = join(value.root, 'result-schema.json');
  await writeFile(schemaPath, JSON.stringify(codexResultSchema));
  return {
    value,
    arguments_: [
      '--ask-for-approval=never',
      'exec',
      '--ignore-user-config',
      '--json',
      '--output-schema',
      schemaPath,
      '--sandbox=read-only',
      '--config',
      'sandbox_workspace_write.network_access=false',
      '--model',
      'test-model',
      '--',
      '-',
    ],
  };
};

const runFixtureParser = (value: FakeCodexFixture, arguments_: readonly string[]) =>
  spawnSync(value.executable, arguments_, { encoding: 'utf8', input: 'prompt' });

const sequenceSpawn = (
  ...results: readonly ReturnType<CodexCliProbeSpawn>[]
): CodexCliProbeSpawn => {
  let cursor = 0;
  return () => {
    const result = results[cursor];
    cursor += 1;
    if (result === undefined) {
      throw new Error('Codex parser smoke requested an unexpected process result.');
    }
    return result;
  };
};

describe('repo-owned Codex CLI scope parser', () => {
  it('accepts the complete root and exec scoped grammar', async () => {
    const { value, arguments_ } = await fixture();

    expect(runFixtureParser(value, arguments_).status).toBe(0);
  });

  it('rejects the previous root option in exec scope before provider output', async () => {
    const { value, arguments_ } = await fixture();
    const legacy = ['exec', '--ignore-user-config', arguments_[0] ?? '', ...arguments_.slice(3)];
    const result = runFixtureParser(value, legacy);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('codex-fixture-parser:root_option_in_exec\n');
    expect(result.stdout).toBe('');
  });

  it.each([
    {
      name: 'exec option in root scope',
      mutate: (arguments_: readonly string[]) => [arguments_[2] ?? '', ...arguments_],
      classification: 'exec_option_in_root',
    },
    {
      name: 'missing exec',
      mutate: (arguments_: readonly string[]) => [arguments_[0] ?? '', ...arguments_.slice(2)],
      classification: 'missing_exec',
    },
    {
      name: 'missing schema value',
      mutate: (arguments_: readonly string[]) => arguments_.filter((_value, index) => index !== 5),
      classification: 'missing_output_schema_value',
    },
    {
      name: 'missing model value',
      mutate: (arguments_: readonly string[]) => arguments_.filter((_value, index) => index !== 10),
      classification: 'missing_model_value',
    },
    {
      name: 'missing terminator',
      mutate: (arguments_: readonly string[]) => arguments_.filter((_value, index) => index !== 11),
      classification: 'missing_terminator',
    },
    {
      name: 'missing stdin marker',
      mutate: (arguments_: readonly string[]) => arguments_.slice(0, -1),
      classification: 'missing_stdin_prompt_marker',
    },
  ])('rejects $name', async ({ mutate, classification }) => {
    const { value, arguments_ } = await fixture();
    const result = runFixtureParser(value, mutate(arguments_));

    expect(result.status).toBe(2);
    expect(result.stderr).toBe(`codex-fixture-parser:${classification}\n`);
  });
});

describe('conditional installed Codex parser smoke', () => {
  it('records the closed environment result without weakening the mandatory parser', () => {
    const result = probeInstalledCodexParser();
    process.stdout.write(`installed-codex-parser-smoke=${JSON.stringify(result)}\n`);

    expect(['passed', 'not_available']).toContain(result.status);
  });

  it('classifies exact compatible exits as passed', () => {
    const observed: string[][] = [];
    const results = sequenceSpawn({ status: 0, signal: null }, { status: 2, signal: null });
    expect(
      probeInstalledCodexParser((arguments_) => {
        observed.push([...arguments_]);
        return results(arguments_);
      }),
    ).toStrictEqual({ status: 'passed', correctExit: 0, legacyExit: 2 });
    expect(observed).toStrictEqual([
      ['--ask-for-approval=never', 'exec', '--ignore-user-config', '--help'],
      ['exec', '--ignore-user-config', '--ask-for-approval=never', '--help'],
    ]);
  });

  it('classifies only a first-spawn ENOENT as not available', () => {
    expect(
      probeInstalledCodexParser(
        sequenceSpawn({ status: null, signal: null, error: { code: 'ENOENT' } }),
      ),
    ).toStrictEqual({ status: 'not_available', reason: 'executable_not_found' });
  });

  it('fails a parser exit mismatch', () => {
    expect(
      probeInstalledCodexParser(
        sequenceSpawn({ status: 0, signal: null }, { status: 0, signal: null }),
      ),
    ).toStrictEqual({
      status: 'failed',
      reason: 'parser_contract_mismatch',
      correctExit: 0,
      legacyExit: 0,
    });
  });

  it.each([
    {
      name: 'permission failure',
      spawn: sequenceSpawn({ status: null, signal: null, error: { code: 'EACCES' } }),
      expected: {
        status: 'failed',
        reason: 'spawn_failed',
        phase: 'correct',
        errorCode: 'EACCES',
      },
    },
    {
      name: 'signal',
      spawn: sequenceSpawn({ status: null, signal: 'SIGTERM' }),
      expected: { status: 'failed', reason: 'signalled', phase: 'correct', signal: 'SIGTERM' },
    },
    {
      name: 'null exit without error',
      spawn: sequenceSpawn({ status: null, signal: null }),
      expected: {
        status: 'failed',
        reason: 'spawn_failed',
        phase: 'correct',
        errorCode: 'missing_exit_status',
      },
    },
    {
      name: 'legacy ENOENT after an available correct probe',
      spawn: sequenceSpawn(
        { status: 0, signal: null },
        { status: null, signal: null, error: { code: 'ENOENT' } },
      ),
      expected: {
        status: 'failed',
        reason: 'spawn_failed',
        phase: 'legacy',
        errorCode: 'ENOENT',
      },
    },
  ])('fails $name instead of reporting absence', ({ spawn, expected }) => {
    expect(probeInstalledCodexParser(spawn)).toStrictEqual(expected);
  });
});
