import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { actionableSonarIssues } from '../../scripts/sonar-issue-status.mjs';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

describe('Sonar issue status inspection', () => {
  it('keeps the workflow issue-inspection command executable and fail-closed', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(isRecord(packageJson)).toBe(true);
    const scripts = isRecord(packageJson) ? packageJson['scripts'] : undefined;
    expect(isRecord(scripts) ? scripts['sonar:issues:local'] : undefined).toBe(
      'bash scripts/sonar-issues-local.sh',
    );

    const result = spawnSync('bash', ['scripts/sonar-issues-local.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SONAR_ENV_FILE: '/nonexistent/revo-run-sonar.env',
        SONAR_TOKEN: '',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SONAR_TOKEN is required to inspect Sonar issues');
  });

  it('ignores stale closed rows while retaining actionable rows', () => {
    const open = { key: 'open', status: 'OPEN', issueStatus: 'OPEN' };
    const confirmed = { key: 'confirmed', status: 'CONFIRMED' };

    expect(
      actionableSonarIssues({
        issues: [
          { key: 'closed', status: 'CLOSED' },
          { key: 'fixed', status: 'CLOSED', resolution: 'FIXED', issueStatus: 'FIXED' },
          { key: 'accepted', status: 'ACCEPTED' },
          { key: 'accepted-current', status: 'RESOLVED', issueStatus: 'ACCEPTED' },
          { key: 'false-positive', status: 'FALSE_POSITIVE' },
          open,
          confirmed,
        ],
      }),
    ).toEqual([open, confirmed]);
  });

  it('fails closed for malformed or missing issue lists', () => {
    expect(() => actionableSonarIssues(null)).toThrow(TypeError);
    expect(() => actionableSonarIssues({})).toThrow(TypeError);
  });

  it.each([
    null,
    [],
    {},
    { status: 1 },
    { issueStatus: [] },
    { issueStatus: 'FUTURE_UNKNOWN' },
    { status: 'CLOSED', issueStatus: null },
    { status: 'OPEN', issueStatus: null },
    { status: 'OPEN', issueStatus: undefined },
  ])('fails closed for an invalid issue row %#', (issue) => {
    expect(() => actionableSonarIssues({ issues: [issue] })).toThrow(TypeError);
  });
});
