import type {
  AgentExecutorBinding,
  ArtifactReference,
  CompiledPipeline,
  EntityReference,
  ExecutionBinding,
  ExecutionPlan,
  InputSource,
  JsonValue,
  NodeOutput,
  OutcomeSwitchNode,
  OutputValue,
  PipelineNode,
  RetryPolicy,
  SecretReference,
  ScriptExecutorBinding,
  SequenceNode,
  TaskNode,
  TerminalOutputSource,
} from '../../src/index.js';

const defaultPolicies = {
  defaultTaskTimeoutMs: 3_600_000,
  maximumActiveNodeExecutions: 10,
  maximumNodeNestingDepth: 10,
  maximumSubpipelineDepth: 10,
  maximumTotalNodeExecutions: 1_000,
} as const;

type InputSourceOf<Kind extends InputSource['kind']> = Extract<InputSource, { kind: Kind }>;

export const executionPlan = (
  root: PipelineNode,
  options: {
    readonly rootPipelineId?: string;
    readonly pipelines?: Readonly<Record<string, PipelineNode>>;
    readonly bindings?: readonly ExecutionBinding[];
    readonly policies?: Partial<ExecutionPlan['policies']>;
  } = {},
): ExecutionPlan => {
  const rootPipelineId = options.rootPipelineId ?? 'main';
  const pipelineRoots = { [rootPipelineId]: root, ...options.pipelines };

  return {
    schemaVersion: 1,
    rootPipelineId,
    pipelines: Object.fromEntries(
      Object.entries(pipelineRoots).map(([id, pipelineRoot]) => [
        id,
        { root: pipelineRoot } satisfies CompiledPipeline,
      ]),
    ),
    bindings: options.bindings ?? [],
    policies: { ...defaultPolicies, ...options.policies },
  };
};

export const sequence = (...children: readonly PipelineNode[]): SequenceNode => ({
  kind: 'sequence',
  children,
});

export const task = (
  key: string,
  options: Pick<TaskNode, 'input' | 'recovery' | 'retry' | 'timeoutMs'> = {},
): TaskNode => ({ kind: 'task', key, ...options });

export const routeOutcomes = (
  source: PipelineNode,
  cases: Readonly<Record<string, PipelineNode>>,
  defaultRoute?: PipelineNode,
): OutcomeSwitchNode => ({
  kind: 'outcomeSwitch',
  source,
  cases,
  ...(defaultRoute === undefined ? {} : { default: defaultRoute }),
});

export const end = (
  status: 'cancelled' | 'failed' | 'succeeded',
  options: {
    readonly outcome?: string;
    readonly output?: Readonly<Record<string, TerminalOutputSource>>;
  } = {},
): PipelineNode => ({
  kind: 'end',
  status,
  outcome: options.outcome ?? status,
  ...(options.output === undefined ? {} : { output: options.output }),
});

export const agentBinding = (
  nodePath: string,
  roleId: string,
  options: {
    readonly agentId?: string;
    readonly modelId?: string;
    readonly pipelineId?: string;
  } = {},
): AgentExecutorBinding => ({
  kind: 'agent',
  target: { pipelineId: options.pipelineId ?? 'main', nodePath },
  agentId: options.agentId ?? 'codex',
  roleId,
  modelId: options.modelId ?? 'gpt-5.6',
});

export const scriptBinding = (
  nodePath: string,
  scriptId: string,
  options: { readonly pipelineId?: string; readonly version?: string } = {},
): ScriptExecutorBinding => ({
  kind: 'script',
  target: { pipelineId: options.pipelineId ?? 'main', nodePath },
  script: { id: scriptId, version: options.version ?? '1.0.0' },
});

export const fromRunInput = (path: string): InputSourceOf<'runInput'> => ({
  kind: 'runInput',
  path,
});

export const fromPipelineInput = (path: string): InputSourceOf<'pipelineInput'> => ({
  kind: 'pipelineInput',
  path,
});

export const fromNodeOutput = (
  nodePath: string,
  path?: string,
  outputKey = 'result',
): InputSourceOf<'nodeOutput'> => ({
  kind: 'nodeOutput',
  nodePath,
  outputKey,
  ...(path === undefined ? {} : { path }),
});

export const fromIterationInput = (path: string): InputSourceOf<'iterationInput'> => ({
  kind: 'iterationInput',
  path,
});

export const fromIterationOutput = (
  path?: string,
  outputKey = 'result',
): InputSourceOf<'iterationOutput'> => ({
  kind: 'iterationOutput',
  outputKey,
  ...(path === undefined ? {} : { path }),
});

export const fromMapItem = (path: string): InputSourceOf<'mapItem'> => ({
  kind: 'mapItem',
  path,
});

export const artifact = (reference: ArtifactReference): InputSourceOf<'artifact'> => ({
  kind: 'artifact',
  reference,
});

export const entity = (reference: EntityReference): InputSourceOf<'entity'> => ({
  kind: 'entity',
  reference,
});

export const secret = (reference: SecretReference): InputSourceOf<'secret'> => ({
  kind: 'secret',
  reference,
});

export const literal = (value: JsonValue): InputSourceOf<'literal'> => ({
  kind: 'literal',
  value,
});

export const jsonOutput = (value: JsonValue, key = 'result'): NodeOutput => ({
  [key]: { kind: 'json', value },
});

export const output = (values: Readonly<Record<string, OutputValue>>): NodeOutput => values;

export const retryPolicy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maximumAttempts: 3,
  backoff: {
    kind: 'exponential',
    initialDelayMs: 1_000,
    maximumDelayMs: 60_000,
  },
  retryableErrorCodes: ['provider_unavailable', 'rate_limited'],
  ...overrides,
});
