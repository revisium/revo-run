import { spawnSync } from 'node:child_process';

type ProbePhase = 'correct' | 'legacy';

export type CodexCliParserSmokeResult =
  | Readonly<{ status: 'passed'; correctExit: 0; legacyExit: 2 }>
  | Readonly<{ status: 'not_available'; reason: 'executable_not_found' }>
  | Readonly<{
      status: 'failed';
      reason: 'parser_contract_mismatch';
      correctExit: number;
      legacyExit: number;
    }>
  | Readonly<{
      status: 'failed';
      reason: 'spawn_failed';
      phase: ProbePhase;
      errorCode: string;
    }>
  | Readonly<{
      status: 'failed';
      reason: 'signalled';
      phase: ProbePhase;
      signal: string;
    }>;

export type CodexCliProbeSpawn = (arguments_: readonly string[]) => Readonly<{
  status: number | null;
  signal: string | null;
  error?: Readonly<{ code?: string }>;
}>;

const correctArguments = [
  '--ask-for-approval=never',
  'exec',
  '--ignore-user-config',
  '--help',
] as const;
const legacyArguments = [
  'exec',
  '--ignore-user-config',
  '--ask-for-approval=never',
  '--help',
] as const;

const spawnInstalledCodex: CodexCliProbeSpawn = (arguments_) => {
  const result = spawnSync('codex', arguments_, {
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 5_000,
  });
  const errorCode =
    result.error !== undefined && 'code' in result.error && typeof result.error.code === 'string'
      ? result.error.code
      : undefined;
  return {
    status: result.status,
    signal: result.signal,
    ...(result.error === undefined
      ? {}
      : { error: { ...(errorCode === undefined ? {} : { code: errorCode }) } }),
  };
};

const completedExit = (
  phase: ProbePhase,
  result: ReturnType<CodexCliProbeSpawn>,
  allowNotAvailable: boolean,
): number | CodexCliParserSmokeResult => {
  if (result.error !== undefined) {
    if (allowNotAvailable && result.error.code === 'ENOENT') {
      return { status: 'not_available', reason: 'executable_not_found' };
    }
    return {
      status: 'failed',
      reason: 'spawn_failed',
      phase,
      errorCode: result.error.code ?? 'unknown_spawn_error',
    };
  }
  if (result.signal !== null) {
    return { status: 'failed', reason: 'signalled', phase, signal: result.signal };
  }
  if (result.status === null) {
    return {
      status: 'failed',
      reason: 'spawn_failed',
      phase,
      errorCode: 'missing_exit_status',
    };
  }
  return result.status;
};

export const probeInstalledCodexParser = (
  spawn: CodexCliProbeSpawn = spawnInstalledCodex,
): CodexCliParserSmokeResult => {
  const correct = completedExit('correct', spawn(correctArguments), true);
  if (typeof correct !== 'number') {
    return correct;
  }
  const legacy = completedExit('legacy', spawn(legacyArguments), false);
  if (typeof legacy !== 'number') {
    return legacy;
  }
  if (correct === 0 && legacy === 2) {
    return { status: 'passed', correctExit: 0, legacyExit: 2 };
  }
  return {
    status: 'failed',
    reason: 'parser_contract_mismatch',
    correctExit: correct,
    legacyExit: legacy,
  };
};
