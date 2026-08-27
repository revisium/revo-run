import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  fields: Map<string, string>;
  env: Map<string, string>;
  with: Map<string, string>;
};

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

const indentation = (line: string): number => line.length - line.trimStart().length;

const withoutYamlComment = (value: string): string => {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") {
          index += 1;
          continue;
        }
        quote = undefined;
      } else if (quote === '"' && character === '\\') {
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/u.test(value[index - 1] ?? ''))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
};

const mappingEntry = (
  line: string,
  expectedIndentation: number,
): { key: string; value: string } | undefined => {
  if (indentation(line) !== expectedIndentation) {
    return undefined;
  }
  const executable = withoutYamlComment(line.slice(expectedIndentation)).trim();
  if (executable === '') {
    return undefined;
  }
  const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/u.exec(executable);
  if (match === null) {
    throw new Error(`Unsupported workflow mapping entry: ${line.trim()}`);
  }
  return { key: match[1]!, value: match[2] ?? '' };
};

const blockScalar = (lines: readonly string[], start: number, parentIndentation: number) => {
  const value: string[] = [];
  let end = start;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() !== '' && indentation(line) <= parentIndentation) {
      break;
    }
    value.push(line.trim());
    end += 1;
  }
  return { end, value: value.join('\n').trim() };
};

const addEntry = (target: Map<string, string>, key: string, value: string): void => {
  if (target.has(key)) {
    throw new Error(`Duplicate workflow key: ${key}`);
  }
  target.set(key, value);
};

const parseStep = (sourceLines: readonly string[]): WorkflowStep => {
  const fields = new Map<string, string>();
  const nested = { env: new Map<string, string>(), with: new Map<string, string>() };
  const lines = [...sourceLines];
  lines[0] = `        ${lines[0]!.slice(8)}`;

  for (let index = 0; index < lines.length; index += 1) {
    const entry = mappingEntry(lines[index]!, 8);
    if (entry === undefined) {
      continue;
    }
    if (entry.key === 'env' || entry.key === 'with') {
      const target = nested[entry.key];
      let nestedIndex = index + 1;
      while (nestedIndex < lines.length) {
        const line = lines[nestedIndex]!;
        if (line.trim() !== '' && indentation(line) <= 8) {
          break;
        }
        const nestedEntry = mappingEntry(line, 10);
        if (nestedEntry !== undefined) {
          if (/^[>|]/u.test(nestedEntry.value)) {
            const block = blockScalar(lines, nestedIndex + 1, 10);
            addEntry(target, nestedEntry.key, block.value);
            nestedIndex = block.end;
            continue;
          }
          addEntry(target, nestedEntry.key, nestedEntry.value);
        }
        nestedIndex += 1;
      }
      index = nestedIndex - 1;
      continue;
    }
    if (/^[>|]/u.test(entry.value)) {
      const block = blockScalar(lines, index + 1, 8);
      addEntry(fields, entry.key, block.value);
      index = block.end - 1;
      continue;
    }
    addEntry(fields, entry.key, entry.value);
  }
  return { fields, ...nested };
};

const parseVerifySteps = (source: string): WorkflowStep[] => {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const executableLine = (line: string): string => withoutYamlComment(line).trimEnd();
  const jobsIndex = lines.findIndex((line) => executableLine(line) === 'jobs:');
  const verifyIndex = lines.findIndex(
    (line, index) => index > jobsIndex && executableLine(line) === '  verify:',
  );
  const stepsIndex = lines.findIndex(
    (line, index) => index > verifyIndex && executableLine(line) === '    steps:',
  );
  if (jobsIndex === -1 || verifyIndex === -1 || stepsIndex === -1) {
    throw new Error('jobs.verify.steps was not found in the CI workflow.');
  }

  let stepsEnd = stepsIndex + 1;
  while (stepsEnd < lines.length) {
    const line = lines[stepsEnd]!;
    if (line.trim() !== '' && !line.trimStart().startsWith('#') && indentation(line) <= 4) {
      break;
    }
    stepsEnd += 1;
  }
  const starts: number[] = [];
  for (let index = stepsIndex + 1; index < stepsEnd; index += 1) {
    if (/^ {6}-\s+[^#\s]/u.test(executableLine(lines[index]!))) {
      starts.push(index);
    }
  }
  return starts.map((start, index) => parseStep(lines.slice(start, starts[index + 1] ?? stepsEnd)));
};

const requireExactlyOne = (steps: readonly WorkflowStep[], name: string): WorkflowStep => {
  const matches = steps.filter((step) => step.fields.get('name') === name);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one workflow step named ${name}; found ${matches.length}.`);
  }
  return matches[0]!;
};

const issueCommandOccurrences = (step: WorkflowStep): number => {
  const executableRun = (step.fields.get('run') ?? '')
    .split('\n')
    .map(withoutYamlComment)
    .filter((line) => line.trim() !== '')
    .join('\n');
  return (
    executableRun.match(
      /(?:^|[\n;&|])\s*(?:(?:corepack\s+)?pnpm\s+(?:run\s+)?sonar:issues:local|(?:(?:ba)?sh\s+)?(?:\.\/)?scripts\/sonar-issues-local\.sh)(?=$|\s|[;&|])/gu,
    )?.length ?? 0
  );
};

const issueScriptReferences = (step: WorkflowStep): number => {
  const executableRun = (step.fields.get('run') ?? '')
    .split('\n')
    .map(withoutYamlComment)
    .join('\n');
  return (
    executableRun.match(/sonar:issues:local|(?:\.\/)?scripts\/sonar-issues-local\.sh/gu)?.length ??
    0
  );
};

const scannerActionReferences = (step: WorkflowStep): number =>
  [...step.fields.values(), ...step.env.values(), ...step.with.values()]
    .join('\n')
    .match(/SonarSource\/sonarqube-scan-action@/gu)?.length ?? 0;

const normalizedStep = (step: WorkflowStep) => ({
  fields: Object.fromEntries(step.fields),
  env: Object.fromEntries(step.env),
  with: Object.fromEntries(step.with),
});

const assertExactStep = (
  actual: WorkflowStep,
  expected: ReturnType<typeof normalizedStep>,
): void => {
  if (!isDeepStrictEqual(normalizedStep(actual), expected)) {
    throw new Error(
      `Workflow step ${String(actual.fields.get('name'))} does not match its contract.`,
    );
  }
};

const assertSonarWorkflow = (source: string): void => {
  const steps = parseVerifySteps(source);
  const checkout = requireExactlyOne(steps, 'Check out repository');
  const providerAccess = requireExactlyOne(steps, 'Require Sonar provider access');
  const branchScan = requireExactlyOne(steps, 'SonarQube branch scan');
  const pullRequestScan = requireExactlyOne(steps, 'SonarQube PR Quality Gate');
  const issueInspection = requireExactlyOne(steps, 'Inspect Sonar open issues');
  const scannerAction =
    'SonarSource/sonarqube-scan-action@713881670b6b3676cda39549040e2d88c70d582e';
  const scannerSteps = steps.filter((step) =>
    step.fields.get('uses')?.startsWith('SonarSource/sonarqube-scan-action@'),
  );
  const scannerReferences = steps.reduce((total, step) => total + scannerActionReferences(step), 0);
  const issueInvocations = steps.reduce((total, step) => total + issueCommandOccurrences(step), 0);
  const issueReferences = steps.reduce((total, step) => total + issueScriptReferences(step), 0);
  const sonarSteps = steps.filter(
    (step) =>
      step.fields.get('name')?.includes('Sonar') === true ||
      step.fields.get('uses')?.startsWith('SonarSource/sonarqube-scan-action@') === true ||
      issueScriptReferences(step) > 0,
  );

  if (
    scannerSteps.length !== 2 ||
    scannerReferences !== 2 ||
    issueInvocations !== 1 ||
    issueReferences !== 1 ||
    sonarSteps.length !== 4
  ) {
    throw new Error(
      `Unexpected Sonar step population: scanners=${scannerSteps.length}, scanner references=${scannerReferences}, issue invocations=${issueInvocations}, issue references=${issueReferences}, total=${sonarSteps.length}.`,
    );
  }
  assertExactStep(checkout, {
    fields: {
      name: 'Check out repository',
      uses: 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
    },
    env: {},
    with: {
      'fetch-depth': '0',
      'persist-credentials': 'false',
      ref: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
    },
  });
  assertExactStep(providerAccess, {
    fields: {
      name: 'Require Sonar provider access',
      run: [
        'if [ -z "$SONAR_TOKEN" ]; then',
        'echo "::error title=Sonar provider unavailable::SONAR_TOKEN is required for the mandatory Sonar quality gate and issue inspection."',
        'exit 1',
        'fi',
      ].join('\n'),
    },
    env: { SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}' },
    with: {},
  });
  assertExactStep(branchScan, {
    fields: {
      name: 'SonarQube branch scan',
      if: "${{ github.event_name != 'pull_request' }}",
      uses: scannerAction,
    },
    env: { SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}' },
    with: {},
  });
  assertExactStep(pullRequestScan, {
    fields: {
      name: 'SonarQube PR Quality Gate',
      if: "${{ github.event_name == 'pull_request' }}",
      uses: scannerAction,
    },
    env: { SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}' },
    with: {
      args: [
        '-Dsonar.qualitygate.wait=true',
        '-Dsonar.qualitygate.timeout=300',
        '-Dsonar.pullrequest.key=${{ github.event.pull_request.number }}',
        '-Dsonar.pullrequest.branch=${{ github.event.pull_request.head.ref }}',
        '-Dsonar.pullrequest.base=${{ github.event.pull_request.base.ref }}',
        '-Dsonar.scm.revision=${{ github.event.pull_request.head.sha }}',
      ].join('\n'),
    },
  });
  assertExactStep(issueInspection, {
    fields: {
      name: 'Inspect Sonar open issues',
      if: "${{ github.event_name == 'pull_request' }}",
      run: 'pnpm sonar:issues:local',
    },
    env: {
      SONAR_EXPECTED_REVISION: '${{ github.event.pull_request.head.sha }}',
      SONAR_PR_KEY: '${{ github.event.pull_request.number }}',
      SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}',
    },
    with: {},
  });
};

const replaceOnce = (source: string, target: string, replacement: string): string => {
  if (source.indexOf(target) === -1 || source.indexOf(target) !== source.lastIndexOf(target)) {
    throw new Error('Hostile workflow mutation target must occur exactly once.');
  }
  return source.replace(target, replacement);
};

describe('CI Sonar workflow contract', () => {
  it('accepts the executable scanner and issue-inspection structure', () => {
    expect(() => assertSonarWorkflow(workflow)).not.toThrow();
  });

  it.each(['SonarQube branch scan', 'SonarQube PR Quality Gate', 'Inspect Sonar open issues'])(
    'rejects a commented-out condition on %s',
    (name) => {
      const condition = requireExactlyOne(parseVerifySteps(workflow), name).fields.get('if');
      const target = [`      - name: ${name}`, `        if: ${condition}`].join('\n');
      const hostile = replaceOnce(
        workflow,
        target,
        target.replace('\n        if:', '\n        # if:'),
      );

      expect(requireExactlyOne(parseVerifySteps(hostile), name).fields.has('if')).toBe(false);
      expect(() => assertSonarWorkflow(hostile)).toThrow(
        `Workflow step ${name} does not match its contract.`,
      );
    },
  );

  it('rejects checkout of the synthetic PR merge commit', () => {
    const hostile = replaceOnce(
      workflow,
      "          ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}\n",
      '',
    );

    expect(() => assertSonarWorkflow(hostile)).toThrow(
      'Workflow step Check out repository does not match its contract.',
    );
  });

  it.each([
    ['pnpm command', 'pnpm sonar:issues:local'],
    ['pnpm run command with whitespace', 'pnpm   run   sonar:issues:local'],
    ['bash script with whitespace', 'bash   scripts/sonar-issues-local.sh'],
    ['direct script', './scripts/sonar-issues-local.sh'],
  ])('rejects an additional branch issue invocation through %s', (_label, command) => {
    const duplicate = [
      '      - name: Inspect Sonar open issues on branch',
      "        if: ${{ github.event_name != 'pull_request' }}",
      `        run: ${command}`,
      '',
    ].join('\n');
    const hostile = replaceOnce(
      workflow,
      '      - name: Inspect Sonar open issues\n',
      `${duplicate}      - name: Inspect Sonar open issues\n`,
    );

    expect(() => assertSonarWorkflow(hostile)).toThrow(
      'Unexpected Sonar step population: scanners=2, scanner references=2, issue invocations=2, issue references=2, total=5.',
    );
  });

  it('rejects a provider-access body that echoes the token', () => {
    const hostile = replaceOnce(
      workflow,
      '          echo "::error title=Sonar provider unavailable::SONAR_TOKEN is required for the mandatory Sonar quality gate and issue inspection."',
      '          echo "$SONAR_TOKEN"',
    );

    expect(() => assertSonarWorkflow(hostile)).toThrow(
      'Workflow step Require Sonar provider access does not match its contract.',
    );
  });

  it.each([
    ['a later false override', '-Dsonar.qualitygate.wait=false'],
    ['a duplicate property', '-Dsonar.qualitygate.wait=true'],
  ])('rejects PR scanner args with %s', (_label, extraArgument) => {
    const hostile = replaceOnce(
      workflow,
      '            -Dsonar.qualitygate.wait=true\n',
      `            -Dsonar.qualitygate.wait=true\n            ${extraArgument}\n`,
    );

    expect(() => assertSonarWorkflow(hostile)).toThrow(
      'Workflow step SonarQube PR Quality Gate does not match its contract.',
    );
  });

  it('rejects an additional unnamed scanner step', () => {
    const duplicate = [
      '      - uses: SonarSource/sonarqube-scan-action@713881670b6b3676cda39549040e2d88c70d582e',
      "        if: ${{ github.event_name != 'pull_request' }}",
      '',
    ].join('\n');
    const hostile = replaceOnce(
      workflow,
      '      - name: SonarQube branch scan\n',
      `${duplicate}      - name: SonarQube branch scan\n`,
    );

    expect(() => assertSonarWorkflow(hostile)).toThrow(
      'Unexpected Sonar step population: scanners=3, scanner references=3, issue invocations=1, issue references=1, total=5.',
    );
  });
});
