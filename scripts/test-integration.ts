import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const suffix = randomUUID().replaceAll('-', '');
const container = `revo-run-test-${suffix}`;
const database = `revo_run_test_${suffix}`;
const waitUntilReady = async (attempt = 0): Promise<void> => {
  const ready = spawnSync(
    'docker',
    [
      'exec',
      container,
      'psql',
      '--username',
      'postgres',
      '--dbname',
      database,
      '--tuples-only',
      '--no-align',
      '--command',
      'SELECT current_database()',
    ],
    { encoding: 'utf8' },
  );
  if (ready.status === 0 && ready.stdout.trim() === database) {
    return;
  }
  if (attempt === 59) {
    throw new Error('PostgreSQL test container did not become ready.');
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return waitUntilReady(attempt + 1);
};

try {
  execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD=revo_run_test',
      '--env',
      `POSTGRES_DB=${database}`,
      'postgres:17-alpine',
    ],
    { stdio: 'ignore' },
  );
  await waitUntilReady();
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' })
    .trim()
    .split(':')
    .at(-1);
  if (port === undefined) {
    throw new Error('PostgreSQL test port was not published.');
  }
  execFileSync('vitest', ['run', 'test/integration'], {
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://postgres:revo_run_test@127.0.0.1:${port}/${database}`,
      REVO_RUN_TEST_DATABASE: database,
    },
    stdio: 'inherit',
  });
} finally {
  spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
}
