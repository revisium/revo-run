import { PipelineSelectionsSchema, type PipelineSelections } from '@revisium/revo-pipeline';
import { Type } from 'typebox';

import { JsonValueSchema, type JsonValue } from './json.js';

const closed = <T extends Record<string, import('typebox').TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const identifier = Type.String({ minLength: 1, maxLength: 256 });

export const AgentAssignmentSchema = closed({
  definition: closed({ id: identifier, version: identifier }),
  parameters: Type.Record(Type.String(), JsonValueSchema),
  permissions: Type.Record(Type.String(), JsonValueSchema),
  workspaceRef: identifier,
  credentials: Type.Optional(Type.Record(Type.String(), identifier)),
});

export const ScriptAssignmentSchema = closed({
  resources: Type.Record(
    Type.String(),
    closed({ resourceRef: identifier, workspaceRef: Type.Optional(identifier) }),
  ),
  credentials: Type.Record(Type.String(), identifier),
});

export const RunProfileSchema = closed({
  schemaVersion: Type.Literal('run-profile/v1'),
  selections: PipelineSelectionsSchema,
  bindings: closed({
    agents: Type.Record(Type.String(), AgentAssignmentSchema),
    scripts: Type.Record(Type.String(), ScriptAssignmentSchema),
  }),
});

export interface AgentAssignment {
  readonly definition: Readonly<{ readonly id: string; readonly version: string }>;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly permissions: Readonly<Record<string, JsonValue>>;
  readonly workspaceRef: string;
  readonly credentials?: Readonly<Record<string, string>>;
}

export interface ScriptAssignment {
  readonly resources: Readonly<
    Record<string, Readonly<{ readonly resourceRef: string; readonly workspaceRef?: string }>>
  >;
  readonly credentials: Readonly<Record<string, string>>;
}

export interface RunProfile {
  readonly schemaVersion: 'run-profile/v1';
  readonly selections: PipelineSelections;
  readonly bindings: Readonly<{
    readonly agents: Readonly<Record<string, AgentAssignment>>;
    readonly scripts: Readonly<Record<string, ScriptAssignment>>;
  }>;
}
