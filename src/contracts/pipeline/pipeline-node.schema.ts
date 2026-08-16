import Type from 'typebox';

import {
  IdentifierSchema,
  JsonPointerSchema,
  PositiveSafeIntegerSchema,
} from '../schema-primitives.js';
import { InputSourceSchema, TerminalOutputSourceSchema } from './data-reference.js';
import type { PipelineNode, RepeatBodyNode } from './pipeline-node.js';
import { RecoveryPolicySchema, RetryPolicySchema } from './task-policy.js';

const InputMappingSchema = Type.Record(IdentifierSchema, InputSourceSchema, {
  additionalProperties: false,
});

const TerminalOutputMappingSchema = Type.Record(IdentifierSchema, TerminalOutputSourceSchema, {
  additionalProperties: false,
});

export const RemainingBranchPolicySchema = Type.Union([
  Type.Literal('cancel'),
  Type.Literal('drain'),
]);

export const ConsensusPolicySchema = Type.Union([
  Type.Object({ kind: Type.Literal('unanimous') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('quorum'), count: PositiveSafeIntegerSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('threshold'),
      approve: PositiveSafeIntegerSchema,
      reject: PositiveSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
]);

export const HumanGateDecisionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('firstAnswer') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('matchingAnswers'),
      count: PositiveSafeIntegerSchema,
      onConflict: Type.Union([Type.Literal('conflict'), Type.Literal('wait')]),
    },
    { additionalProperties: false },
  ),
]);

const SuccessfulOutcomesSchema = Type.Array(IdentifierSchema, {
  minItems: 1,
  uniqueItems: true,
});

const PipelineNodeType = Type.Cyclic(
  {
    TaskNode: Type.Object(
      {
        kind: Type.Literal('task'),
        key: IdentifierSchema,
        input: Type.Optional(InputMappingSchema),
        retry: Type.Optional(RetryPolicySchema),
        recovery: Type.Optional(RecoveryPolicySchema),
        timeoutMs: Type.Optional(PositiveSafeIntegerSchema),
      },
      { additionalProperties: false },
    ),
    SequenceNode: Type.Object(
      {
        kind: Type.Literal('sequence'),
        children: Type.Array(Type.Ref('PipelineNode'), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    OutcomeSwitchNode: Type.Object(
      {
        kind: Type.Literal('outcomeSwitch'),
        source: Type.Ref('PipelineNode'),
        cases: Type.Record(IdentifierSchema, Type.Ref('PipelineNode'), {
          additionalProperties: false,
          minProperties: 1,
        }),
        default: Type.Optional(Type.Ref('PipelineNode')),
      },
      { additionalProperties: false },
    ),
    BranchNode: Type.Object(
      {
        kind: Type.Literal('branch'),
        key: IdentifierSchema,
        value: InputSourceSchema,
        cases: Type.Record(IdentifierSchema, Type.Ref('PipelineNode'), {
          additionalProperties: false,
          minProperties: 1,
        }),
        default: Type.Optional(Type.Ref('PipelineNode')),
      },
      { additionalProperties: false },
    ),
    ParallelNode: Type.Object(
      {
        kind: Type.Literal('parallel'),
        key: IdentifierSchema,
        branches: Type.Record(IdentifierSchema, Type.Ref('PipelineNode'), {
          additionalProperties: false,
          minProperties: 1,
        }),
        join: Type.Union([
          Type.Object(
            {
              kind: Type.Literal('all'),
              successfulOutcomes: SuccessfulOutcomesSchema,
              remaining: RemainingBranchPolicySchema,
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              kind: Type.Literal('any'),
              successfulOutcomes: SuccessfulOutcomesSchema,
              remaining: RemainingBranchPolicySchema,
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              kind: Type.Literal('threshold'),
              count: PositiveSafeIntegerSchema,
              successfulOutcomes: SuccessfulOutcomesSchema,
              remaining: RemainingBranchPolicySchema,
            },
            { additionalProperties: false },
          ),
        ]),
      },
      { additionalProperties: false },
    ),
    ConsensusNode: Type.Object(
      {
        kind: Type.Literal('consensus'),
        key: IdentifierSchema,
        participants: Type.Record(IdentifierSchema, Type.Ref('TaskNode'), {
          additionalProperties: false,
          minProperties: 1,
        }),
        policy: ConsensusPolicySchema,
        remaining: RemainingBranchPolicySchema,
        timeoutMs: Type.Optional(PositiveSafeIntegerSchema),
      },
      { additionalProperties: false },
    ),
    HumanGateNode: Type.Object(
      {
        kind: Type.Literal('humanGate'),
        key: IdentifierSchema,
        answers: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
        decision: HumanGateDecisionSchema,
        eligibleGroup: Type.Optional(IdentifierSchema),
        timeoutMs: Type.Optional(PositiveSafeIntegerSchema),
      },
      { additionalProperties: false },
    ),
    RepeatNode: Type.Object(
      {
        kind: Type.Literal('repeat'),
        key: IdentifierSchema,
        maximumIterations: PositiveSafeIntegerSchema,
        continueOn: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
        completeOn: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
        initialInput: Type.Optional(InputMappingSchema),
        nextInput: Type.Optional(InputMappingSchema),
        body: Type.Union([
          Type.Ref('ParallelNode'),
          Type.Ref('RepeatNode'),
          Type.Ref('SubpipelineNode'),
          Type.Ref('TaskNode'),
        ]),
      },
      { additionalProperties: false },
    ),
    SubpipelineNode: Type.Object(
      {
        kind: Type.Literal('subpipeline'),
        key: IdentifierSchema,
        pipelineId: IdentifierSchema,
        input: Type.Optional(InputMappingSchema),
      },
      { additionalProperties: false },
    ),
    MapNode: Type.Object(
      {
        kind: Type.Literal('map'),
        key: IdentifierSchema,
        items: InputSourceSchema,
        itemKeyPath: JsonPointerSchema,
        maximumItems: PositiveSafeIntegerSchema,
        concurrency: PositiveSafeIntegerSchema,
        failure: Type.Union([
          Type.Object(
            {
              kind: Type.Literal('failFast'),
              remaining: RemainingBranchPolicySchema,
            },
            { additionalProperties: false },
          ),
          Type.Object({ kind: Type.Literal('collect') }, { additionalProperties: false }),
        ]),
        body: Type.Ref('PipelineNode'),
      },
      { additionalProperties: false },
    ),
    DelayNode: Type.Object(
      { kind: Type.Literal('delay'), key: IdentifierSchema, durationMs: PositiveSafeIntegerSchema },
      { additionalProperties: false },
    ),
    EndNode: Type.Object(
      {
        kind: Type.Literal('end'),
        status: Type.Union([
          Type.Literal('cancelled'),
          Type.Literal('failed'),
          Type.Literal('succeeded'),
        ]),
        outcome: IdentifierSchema,
        output: Type.Optional(TerminalOutputMappingSchema),
      },
      { additionalProperties: false },
    ),
    PipelineNode: Type.Union([
      Type.Ref('BranchNode'),
      Type.Ref('ConsensusNode'),
      Type.Ref('DelayNode'),
      Type.Ref('EndNode'),
      Type.Ref('HumanGateNode'),
      Type.Ref('MapNode'),
      Type.Ref('OutcomeSwitchNode'),
      Type.Ref('ParallelNode'),
      Type.Ref('RepeatNode'),
      Type.Ref('SequenceNode'),
      Type.Ref('SubpipelineNode'),
      Type.Ref('TaskNode'),
    ]),
  },
  'PipelineNode',
);

export const PipelineNodeSchema = Type.Unsafe<PipelineNode>(PipelineNodeType);

export const RepeatBodyNodeSchema = Type.Unsafe<RepeatBodyNode>(
  Type.Intersect([
    PipelineNodeSchema,
    Type.Object(
      {
        kind: Type.Union([
          Type.Literal('parallel'),
          Type.Literal('repeat'),
          Type.Literal('subpipeline'),
          Type.Literal('task'),
        ]),
      },
      { additionalProperties: true },
    ),
  ]),
);
