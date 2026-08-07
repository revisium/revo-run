import type { ExecutorInput, ExecutorInputValue } from '../../contracts/executor/executor-input.js';
import type { JsonValue } from '../../contracts/json-value.js';
import type { InputSource, TerminalOutputSource } from '../../contracts/pipeline/data-reference.js';
import type { NodeOutput, OutputValue } from '../../contracts/pipeline/node-output.js';
import type { PipelineInputScope } from '../../contracts/pipeline/pipeline-input.js';
import type {
  InputMapping,
  TerminalOutputMapping,
} from '../../contracts/pipeline/pipeline-node.js';
import { readJsonPointer } from './json-pointer.js';

export interface InputResolutionContext {
  readonly runInput: JsonValue;
  readonly pipelineInput: PipelineInputScope;
  readonly outputs: ReadonlyMap<string, NodeOutput>;
}

export type InputResolutionErrorCode =
  | 'input_source_unavailable'
  | 'json_pointer_not_found'
  | 'node_output_not_found'
  | 'output_key_not_found';

type Resolution<T> =
  | { readonly resolved: true; readonly value: T }
  | { readonly resolved: false; readonly errorCode: InputResolutionErrorCode };

const json = (value: JsonValue): OutputValue => ({ kind: 'json', value });

const selectJson = (value: ExecutorInputValue, pointer: string): Resolution<ExecutorInputValue> => {
  if (pointer === '') {
    return { resolved: true, value };
  }
  if (value.kind !== 'json') {
    return { resolved: false, errorCode: 'json_pointer_not_found' };
  }

  const selected = readJsonPointer(value.value, pointer);
  return selected.found
    ? { resolved: true, value: json(selected.value) }
    : { resolved: false, errorCode: 'json_pointer_not_found' };
};

const selectPipelineInput = (
  scope: PipelineInputScope,
  pointer: string,
): Resolution<ExecutorInputValue> => {
  if (scope.kind === 'value') {
    return selectJson(scope.value, pointer);
  }
  if (pointer === '') {
    if (Object.values(scope.values).some(({ kind }) => kind !== 'json')) {
      return { resolved: false, errorCode: 'input_source_unavailable' };
    }

    const values: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(scope.values)) {
      if (value.kind === 'json') {
        values[key] = value.value;
      }
    }
    return { resolved: true, value: json(values) };
  }

  const [field, ...remainingTokens] = pointer.slice(1).split('/');
  if (field === undefined || !Object.hasOwn(scope.values, field)) {
    return { resolved: false, errorCode: 'json_pointer_not_found' };
  }

  const value = scope.values[field];
  if (value === undefined) {
    return { resolved: false, errorCode: 'json_pointer_not_found' };
  }

  const remainingPointer = remainingTokens.length === 0 ? '' : `/${remainingTokens.join('/')}`;
  return selectJson(value, remainingPointer);
};

export class InputResolver {
  private readonly context: InputResolutionContext;

  constructor(context: InputResolutionContext) {
    this.context = context;
  }

  resolveMapping(mapping: InputMapping | undefined): Resolution<ExecutorInput> {
    return this.resolveEntries(mapping ?? {});
  }

  resolveTerminalOutput(mapping: TerminalOutputMapping | undefined): Resolution<NodeOutput> {
    const resolved: Record<string, OutputValue> = {};
    for (const [key, source] of Object.entries(mapping ?? {})) {
      const value = this.resolve(source);
      if (!value.resolved) {
        return value;
      }
      if (value.value.kind === 'secret') {
        return { resolved: false, errorCode: 'input_source_unavailable' };
      }
      resolved[key] = value.value;
    }
    return { resolved: true, value: resolved };
  }

  resolve(source: InputSource | TerminalOutputSource): Resolution<ExecutorInputValue> {
    switch (source.kind) {
      case 'literal':
        return { resolved: true, value: json(source.value) };
      case 'runInput': {
        const selected = readJsonPointer(this.context.runInput, source.path);
        return selected.found
          ? { resolved: true, value: json(selected.value) }
          : { resolved: false, errorCode: 'json_pointer_not_found' };
      }
      case 'pipelineInput':
        return selectPipelineInput(this.context.pipelineInput, source.path);
      case 'nodeOutput':
        return this.resolveNodeOutput(source.nodePath, source.outputKey, source.path ?? '');
      case 'artifact':
      case 'entity':
      case 'secret':
        return { resolved: true, value: source };
      case 'iterationInput':
      case 'iterationOutput':
      case 'mapItem':
        return { resolved: false, errorCode: 'input_source_unavailable' };
    }

    source satisfies never;
    return source;
  }

  private resolveEntries(
    entries: Readonly<Record<string, InputSource | TerminalOutputSource>>,
  ): Resolution<ExecutorInput> {
    const resolved: Record<string, ExecutorInputValue> = {};
    for (const [key, source] of Object.entries(entries)) {
      const value = this.resolve(source);
      if (!value.resolved) {
        return value;
      }
      resolved[key] = value.value;
    }
    return { resolved: true, value: resolved };
  }

  private resolveNodeOutput(
    nodePath: string,
    outputKey: string,
    pointer: string,
  ): Resolution<ExecutorInputValue> {
    const output = this.context.outputs.get(nodePath);
    if (output === undefined) {
      return { resolved: false, errorCode: 'node_output_not_found' };
    }
    if (!Object.hasOwn(output, outputKey)) {
      return { resolved: false, errorCode: 'output_key_not_found' };
    }

    const value = output[outputKey];
    return value === undefined
      ? { resolved: false, errorCode: 'output_key_not_found' }
      : selectJson(value, pointer);
  }
}
