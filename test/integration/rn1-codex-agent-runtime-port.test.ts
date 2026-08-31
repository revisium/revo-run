import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isJsonObject } from '../../src/contracts/json.js';
import { codexContextCase } from '../support/codex-conformance.js';
import {
  codexBindingInput,
  codexResultSchema,
  createFakeCodexFixture,
  isProcessRunning,
  prepareCodexBinding,
  readFakeCodexCalls,
  removeFakeCodexFixture,
  startFakeCodex,
  startFakeCodexOutcome,
  waitForFakeCodexCalls,
  type FakeCodexFixture,
} from '../support/codex-runtime/fake-codex.js';

const fixtures: FakeCodexFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(removeFakeCodexFixture));
  vi.unstubAllEnvs();
});

const fixture = async (
  ...input: Parameters<typeof createFakeCodexFixture>
): Promise<FakeCodexFixture> => {
  const created = await createFakeCodexFixture(...input);
  fixtures.push(created);
  return created;
};

const outputLeaf = async (value: FakeCodexFixture): Promise<string> => {
  const names = (await readdir(value.root)).filter((name) => name.startsWith('.revo-agent-'));
  expect(names).toHaveLength(1);
  const name = names[0];
  if (name === undefined) {
    throw new Error('Expected one agent output leaf.');
  }
  return join(value.root, name);
};

describe('RN1 Codex agent-runtime adapter', () => {
  it('keeps a direct private adapter call Linux-only before workspace work', async () => {
    const value = await fixture('success');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (descriptor === undefined || !descriptor.configurable) {
      throw new Error('process.platform cannot be safely isolated for this test.');
    }
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
    try {
      await expect(prepareCodexBinding(value)).rejects.toMatchObject({
        code: 'agent_runtime_unavailable',
      });
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }

    expect(value.acquire).not.toHaveBeenCalled();
    await expect(readFile(value.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['unsupported provider', { ...codexBindingInput, definition: { id: 'other', version: '1' } }],
    [
      'wrong definition version',
      { ...codexBindingInput, definition: { id: 'codex', version: 'definition-v2' } },
    ],
    ['credentials', { ...codexBindingInput, credentials: { token: 'secret-ref' } }],
    ['empty credentials', { ...codexBindingInput, credentials: {} }],
    ['missing model', { ...codexBindingInput, parameters: { allowAmbientLogin: true } }],
    ['missing ambient-login opt-in', { ...codexBindingInput, parameters: { model: 'test-model' } }],
    [
      'option-shaped model',
      { ...codexBindingInput, parameters: { model: '--danger', allowAmbientLogin: true } },
    ],
    [
      'newline model',
      { ...codexBindingInput, parameters: { model: 'safe\n--danger', allowAmbientLogin: true } },
    ],
  ] as const)('rejects %s before workspace acquisition or CLI probing', async (_name, input) => {
    const value = await fixture('success');

    await expect(prepareCodexBinding(value, input)).rejects.toMatchObject({
      code: 'agent_runtime_unavailable',
    });

    expect(value.acquire).not.toHaveBeenCalled();
    await expect(readFile(value.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('CTX-ARGV-STDIN uses parser-compatible exec option order and exact adversarial stdin', async () => {
    const context = await codexContextCase('CTX-ARGV-STDIN');
    if (
      !isJsonObject(context.input) ||
      typeof context.input.model !== 'string' ||
      typeof context.input.prompt !== 'string'
    ) {
      throw new Error('CTX-ARGV-STDIN has invalid input.');
    }
    const { model, prompt } = context.input;
    const value = await fixture('success', { version: '1.2.3' });
    const binding = await prepareCodexBinding(value, {
      ...codexBindingInput,
      parameters: { model, allowAmbientLogin: true },
    });
    const outcome = await value.port.start({
      invocationId: 'codex-happy',
      binding,
      prompt,
      result: { schema: codexResultSchema },
    });
    if (outcome.status !== 'accepted') {
      throw new Error(`Expected accepted Codex start, received ${outcome.status}.`);
    }
    const result = await outcome.handle.result();

    expect(result).toStrictEqual({
      schemaVersion: 'agent-terminal-result/v1',
      invocationId: 'codex-happy',
      pin: {
        agentId: 'codex',
        agentVersion: 'definition-v1',
        definitionDigest: result.pin.definitionDigest,
      },
      status: 'succeeded',
      value: { ok: true },
    });
    expect(result.pin.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(value.acquire).toHaveBeenCalledOnce();
    const calls = await waitForFakeCodexCalls(value, 2);
    expect(calls[0]?.args).toStrictEqual(['--version']);
    const renderedArguments = [...(calls[1]?.args ?? [])];
    const legacyArguments = [
      renderedArguments[1] ?? '',
      renderedArguments[2] ?? '',
      renderedArguments[0] ?? '',
      ...renderedArguments.slice(3),
    ];
    const legacyProbe = spawnSync(value.executable, legacyArguments, {
      encoding: 'utf8',
      input: prompt,
    });
    const actualArguments = [...renderedArguments];
    actualArguments[5] = '<runtime-result-schema-file>';
    const actualPrompt = Buffer.from(calls[1]?.stdinBase64 ?? '', 'base64').toString('utf8');
    expect({
      argv: actualArguments,
      stdin: actualPrompt,
      promptPresentInArgv: actualArguments.includes(prompt),
      hostCredentialCalls: 0,
      repoParser: {
        correctAccepted: result.status === 'succeeded',
        legacyRejected:
          legacyProbe.status === 2 &&
          legacyProbe.stderr === 'codex-fixture-parser:root_option_in_exec\n',
      },
    }).toStrictEqual(context.expected);
    expect(await readdir(value.workspace)).toStrictEqual([]);
    expect(await outputLeaf(value)).toContain(value.root);
  });

  it('passes an exact child environment and redacts ambient login paths from output', async () => {
    const value = await fixture('success-with-secret');

    await (await startFakeCodex(value, 'codex-redaction')).result();

    const invocation = (await waitForFakeCodexCalls(value, 2))[1];
    if (invocation === undefined) {
      throw new Error('Expected a Codex invocation call.');
    }
    expect(invocation.home).toBe(value.home);
    expect(invocation.codexHome).toBe(value.codexHome);
    expect(invocation.environment).toEqual(expect.arrayContaining(['PATH', 'HOME', 'CODEX_HOME']));
    expect(
      invocation.environment.every((name) =>
        ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'HOME', 'CODEX_HOME'].includes(name),
      ),
    ).toBe(true);
    const stderr = await readFile(join(await outputLeaf(value), 'stderr.log'), 'utf8');
    expect(stderr).toContain('[REDACTED]');
    expect(stderr).not.toContain(value.home);
    expect(stderr).not.toContain(value.codexHome);
  });

  it('CTX-AMBIENT-AUTH-PER-INVOCATION captures and sanitizes rotating ambient auth', async () => {
    const context = await codexContextCase('CTX-AMBIENT-AUTH-PER-INVOCATION');
    const value = await fixture('success-with-secret');
    const constructionHome = value.home;
    const constructionCodexHome = value.codexHome;
    const homeB = join(value.root, 'ambient-b-home');
    const codexHomeB = join(value.root, 'ambient-b-codex-home');
    const homeC = join(value.root, 'ambient-c-home');
    const codexHomeC = join(value.root, 'ambient-c-codex-home');

    vi.stubEnv('HOME', homeB);
    vi.stubEnv('CODEX_HOME', codexHomeB);
    const first = await startFakeCodex(value, 'codex-auth-b');
    await first.result();

    vi.stubEnv('HOME', homeC);
    vi.stubEnv('CODEX_HOME', codexHomeC);
    const second = await startFakeCodex(value, 'codex-auth-c');
    await second.result();

    vi.stubEnv('HOME', join(value.root, 'ambient-d-home'));
    vi.stubEnv('CODEX_HOME', join(value.root, 'ambient-d-codex-home'));
    const completedLookup = value.port.getResult('codex-auth-b');
    const completedCancel = await value.port.cancel('codex-auth-c');
    const calls = (await waitForFakeCodexCalls(value, 4)).filter(
      ({ stdinBase64 }) => stdinBase64 !== undefined,
    );
    const logs = await Promise.all(
      (await readdir(value.root))
        .filter((name) => name.startsWith('.revo-agent-'))
        .map(async (name) => await readFile(join(value.root, name, 'stderr.log'), 'utf8')),
    );
    const rawSecrets = [
      constructionHome,
      constructionCodexHome,
      homeB,
      codexHomeB,
      homeC,
      codexHomeC,
    ];
    const normalizedChildren = calls.map(({ home, codexHome }) =>
      home === homeB && codexHome === codexHomeB
        ? 'B'
        : home === homeC && codexHome === codexHomeC
          ? 'C'
          : 'unexpected',
    );
    const lookupJson = JSON.stringify(completedLookup);
    const cancelJson = JSON.stringify(completedCancel);

    expect({
      childSecretSets: normalizedChildren,
      constructionSnapshotObserved: calls.some(
        ({ home, codexHome }) => home === constructionHome || codexHome === constructionCodexHome,
      ),
      logsRedacted:
        logs.every((log) => log.includes('[REDACTED]')) &&
        rawSecrets.every((secret) => logs.every((log) => !log.includes(secret))),
      completedLookupSanitized: rawSecrets.every((secret) => !lookupJson.includes(secret)),
      completedCancelSanitized: rawSecrets.every((secret) => !cancelJson.includes(secret)),
    }).toStrictEqual(context.expected);
  });

  it('fails before output claim when the Codex executable is missing', async () => {
    const value = await fixture('success', { installBinary: false });

    await expect(startFakeCodexOutcome(value, 'codex-missing')).resolves.toMatchObject({
      status: 'rejected',
      result: {
        status: 'failed',
        error: { code: 'revo.run.execution_failed' },
      },
    });

    expect((await readdir(value.root)).some((name) => name.startsWith('.revo-agent-'))).toBe(false);
  });

  it('maps workspace acquisition failure to a deterministic generic failure', async () => {
    const value = await fixture('success', { acquireMode: 'reject' });

    await expect(startFakeCodexOutcome(value, 'codex-workspace-failure')).resolves.toMatchObject({
      status: 'rejected',
      result: { status: 'failed', error: { code: 'revo.run.execution_failed' } },
    });

    await expect(readFile(value.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps a durable definition-digest mismatch to unknown without workspace or process work', async () => {
    const value = await fixture('success');
    const prepared = await prepareCodexBinding(value);

    await expect(
      value.port.start({
        invocationId: 'codex-pin-mismatch',
        binding: { ...prepared, pin: { ...prepared.pin, definitionDigest: '0'.repeat(64) } },
        prompt: 'Do not run.',
        result: { schema: { type: 'object', additionalProperties: false } },
      }),
    ).resolves.toStrictEqual({ status: 'unknown' });

    expect(value.acquire).not.toHaveBeenCalled();
    await expect(readFile(value.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['malformed-result', 'revo.agent.result_invalid_json'],
    ['authentication-failure', 'revo.agent.result_missing'],
  ] as const)('fails closed for %s without a fallback invocation', async (mode, code) => {
    const value = await fixture(mode);

    const result = await (await startFakeCodex(value, `codex-${mode}`)).result();

    expect(result).toMatchObject({ status: 'failed', error: { code } });
    expect(await readFakeCodexCalls(value)).toHaveLength(2);
  });

  it('cancels and reaps the selected Codex process', async () => {
    const value = await fixture('wait');
    const handle = await startFakeCodex(value, 'codex-cancel');
    const pid = (await waitForFakeCodexCalls(value, 2))[1]?.pid;
    if (pid === undefined) {
      throw new Error('Expected a Codex process.');
    }

    await handle.cancel('test cancellation');

    expect((await handle.result()).status).toBe('cancelled');
    expect(isProcessRunning(pid)).toBe(false);
  });

  it('times out and reaps the selected Codex process', async () => {
    const value = await fixture('wait');
    const handle = await startFakeCodex(value, 'codex-timeout', {
      wallClockTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    });
    const pid = (await waitForFakeCodexCalls(value, 2))[1]?.pid;
    if (pid === undefined) {
      throw new Error('Expected a Codex process.');
    }

    expect((await handle.result()).status).toBe('timed_out');
    expect(isProcessRunning(pid)).toBe(false);
  });

  it('shutdown reaps accepted Codex work and closes the adapter', async () => {
    const value = await fixture('wait');
    const handle = await startFakeCodex(value, 'codex-shutdown');
    const pid = (await waitForFakeCodexCalls(value, 2))[1]?.pid;
    if (pid === undefined) {
      throw new Error('Expected a Codex process.');
    }

    await value.port.shutdown('test shutdown');

    expect((await handle.result()).status).toBe('cancelled');
    expect(isProcessRunning(pid)).toBe(false);
    await expect(startFakeCodex(value, 'codex-after-shutdown')).rejects.toBeDefined();
  });

  it('CTX-WORKSPACE-PER-INVOCATION acquires twice and derives exclusive sibling outputs', async () => {
    const context = await codexContextCase('CTX-WORKSPACE-PER-INVOCATION');
    if (
      !isJsonObject(context.input) ||
      typeof context.input.workspaceRef !== 'string' ||
      !Array.isArray(context.input.invocationIds) ||
      !context.input.invocationIds.every((id) => typeof id === 'string')
    ) {
      throw new Error('CTX-WORKSPACE-PER-INVOCATION has invalid input.');
    }
    const value = await fixture('success');
    const prepared = await prepareCodexBinding(value, {
      ...codexBindingInput,
      workspaceRef: context.input.workspaceRef,
    });
    const prepareAcquireCalls = value.acquire.mock.calls.length;
    for (const invocationId of context.input.invocationIds) {
      // oxlint-disable-next-line no-await-in-loop -- each completed invocation owns one exclusive output leaf.
      const outcome = await value.port.start({
        invocationId,
        binding: prepared,
        prompt: 'Return exact JSON.',
        result: { schema: codexResultSchema },
      });
      if (outcome.status !== 'accepted') {
        throw new Error(`Expected accepted Codex start, received ${outcome.status}.`);
      }
      // oxlint-disable-next-line no-await-in-loop -- the next invocation must start after this output settles.
      await outcome.handle.result();
    }
    const outputLeaves = (await readdir(value.root)).filter((name) =>
      name.startsWith('.revo-agent-'),
    );
    const durablePaths = Object.values(prepared).filter(
      (item): item is string => typeof item === 'string' && item.startsWith('/'),
    );
    expect({
      prepareAcquireCalls,
      invocationAcquireCalls: value.acquire.mock.calls.length,
      acquiredRefs: value.acquire.mock.calls.map(([workspaceRef]) => workspaceRef),
      outputLeavesDistinct: new Set(outputLeaves).size === context.input.invocationIds.length,
      outputLeavesAreExclusiveSiblings: outputLeaves.every(
        (name) => dirname(join(value.root, name)) === value.root,
      ),
      durablePaths,
    }).toStrictEqual(context.expected);
  });

  it('CTX-PENDING-CANCEL aborts and settles acquisition without a late start', async () => {
    const context = await codexContextCase('CTX-PENDING-CANCEL');
    const value = await fixture('success', { acquireMode: 'until-abort' });
    const starting = startFakeCodexOutcome(value, 'codex-acquire-cancel');
    await vi.waitFor(() => expect(value.acquire).toHaveBeenCalledOnce());

    const [outcome, cancellation] = await Promise.all([
      starting,
      value.port.cancel('codex-acquire-cancel', 'cancel pending acquire'),
    ]);

    expect(cancellation).toStrictEqual({ state: 'unknown' });
    await expect(readFile(value.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect({
      outcome: outcome.status === 'rejected' ? outcome.result.status : outcome.status,
      acquireAborted: true,
      acquireSettled: true,
      runtimeStartCalls: 0,
      childProcesses: 0,
    }).toStrictEqual(context.expected);
  });

  it('CTX-PENDING-SHUTDOWN aborts and settles acquisition before closing', async () => {
    const context = await codexContextCase('CTX-PENDING-SHUTDOWN');
    const value = await fixture('success', { acquireMode: 'until-abort' });
    const starting = startFakeCodexOutcome(value, 'codex-acquire-shutdown');
    await vi.waitFor(() => expect(value.acquire).toHaveBeenCalledOnce());

    await value.port.shutdown('shutdown pending acquire');

    const outcome = await starting;
    await expect(readFile(value.callsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect({
      aborted: outcome.status === 'rejected' && outcome.result.status === 'cancelled',
      settledBeforeReturn: true,
      runtimeStartCalls: 0,
      childProcesses: 0,
    }).toStrictEqual(context.expected);
  });
});
