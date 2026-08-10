import Type from 'typebox';
import type { TSchema } from 'typebox';
import Schema from 'typebox/schema';

import { IdentifierSchema, PositiveSafeIntegerSchema } from '../contracts/schema-primitives.js';

export type ExecutionPlanSchemaFailureCode =
  | 'invalid_execution_plan'
  | 'invalid_node_key'
  | 'invalid_pipeline_id'
  | 'invalid_repeat_bound'
  | 'unsupported_plan_schema_version';

const additionalProperties = { additionalProperties: true } as const;

const KeyedNodeKindSchema = Type.Union([
  Type.Literal('branch'),
  Type.Literal('consensus'),
  Type.Literal('delay'),
  Type.Literal('humanGate'),
  Type.Literal('map'),
  Type.Literal('parallel'),
  Type.Literal('repeat'),
  Type.Literal('subpipeline'),
  Type.Literal('task'),
]);

const BranchingNodeKindSchema = Type.Union([Type.Literal('branch'), Type.Literal('outcomeSwitch')]);

const BodyNodeKindSchema = Type.Union([Type.Literal('map'), Type.Literal('repeat')]);

const ExecutorBindingKindSchema = Type.Union([Type.Literal('agent'), Type.Literal('script')]);

const recurseIntoNode = (kind: TSchema, property: string): TSchema =>
  Type.Dependent(
    Type.Object({ kind, [property]: Type.Object({}, additionalProperties) }, additionalProperties),
    Type.Object({ [property]: Type.Ref('ClassificationNode') }, additionalProperties),
    Type.Unknown(),
  );

const recurseIntoNodeArray = (kind: TSchema, property: string): TSchema =>
  Type.Dependent(
    Type.Object({ kind, [property]: Type.Array(Type.Unknown()) }, additionalProperties),
    Type.Object({ [property]: Type.Array(Type.Ref('ClassificationNode')) }, additionalProperties),
    Type.Unknown(),
  );

const recurseIntoNodeRecord = (
  kind: TSchema,
  property: string,
  reference = 'ClassificationNode',
): TSchema =>
  Type.Dependent(
    Type.Object(
      { kind, [property]: Type.Record(Type.String(), Type.Unknown()) },
      additionalProperties,
    ),
    Type.Object(
      { [property]: Type.Record(Type.String(), Type.Ref(reference)) },
      additionalProperties,
    ),
    Type.Unknown(),
  );

const createClassificationNodeSchema = (constraint: TSchema): TSchema =>
  Type.Cyclic(
    {
      ClassificationNode: Type.Intersect([
        recurseIntoNodeArray(Type.Literal('sequence'), 'children'),
        recurseIntoNode(Type.Literal('outcomeSwitch'), 'source'),
        recurseIntoNodeRecord(BranchingNodeKindSchema, 'cases'),
        recurseIntoNode(BranchingNodeKindSchema, 'default'),
        recurseIntoNodeRecord(Type.Literal('parallel'), 'branches'),
        recurseIntoNodeRecord(Type.Literal('consensus'), 'participants', 'ClassificationTask'),
        recurseIntoNode(BodyNodeKindSchema, 'body'),
        constraint,
      ]),
      ClassificationTask: Type.Dependent(
        Type.Object({ kind: Type.Literal('task') }, additionalProperties),
        constraint,
        Type.Unknown(),
      ),
    },
    'ClassificationNode',
  );

const compileNodeConstraint = (constraint: TSchema) => {
  const node = createClassificationNodeSchema(constraint);
  const pipeline = Type.Dependent(
    Type.Object({ root: Type.Unknown() }, additionalProperties),
    Type.Object({ root: node }, additionalProperties),
    Type.Unknown(),
  );

  return Schema.Compile(
    Type.Dependent(
      Type.Object({ pipelines: Type.Record(Type.String(), Type.Unknown()) }, additionalProperties),
      Type.Object({ pipelines: Type.Record(Type.String(), pipeline) }, additionalProperties),
      Type.Unknown(),
    ),
  );
};

const nodeKeyClassifier = compileNodeConstraint(
  Type.Dependent(
    Type.Object({ kind: KeyedNodeKindSchema, key: Type.Unknown() }, additionalProperties),
    Type.Object({ key: IdentifierSchema }, additionalProperties),
    Type.Unknown(),
  ),
);

const nodePipelineIdClassifier = compileNodeConstraint(
  Type.Dependent(
    Type.Object(
      { kind: Type.Literal('subpipeline'), pipelineId: Type.Unknown() },
      additionalProperties,
    ),
    Type.Object({ pipelineId: IdentifierSchema }, additionalProperties),
    Type.Unknown(),
  ),
);

const repeatBoundClassifier = compileNodeConstraint(
  Type.Dependent(
    Type.Object(
      { kind: Type.Literal('repeat'), maximumIterations: Type.Unknown() },
      additionalProperties,
    ),
    Type.Object({ maximumIterations: PositiveSafeIntegerSchema }, additionalProperties),
    Type.Unknown(),
  ),
);

const bindingPipelineIdClassifier = Schema.Compile(
  Type.Dependent(
    Type.Object({ bindings: Type.Array(Type.Unknown()) }, additionalProperties),
    Type.Object(
      {
        bindings: Type.Array(
          Type.Dependent(
            Type.Object(
              {
                kind: ExecutorBindingKindSchema,
                target: Type.Object({ pipelineId: Type.Unknown() }, additionalProperties),
              },
              additionalProperties,
            ),
            Type.Object(
              {
                target: Type.Object({ pipelineId: IdentifierSchema }, additionalProperties),
              },
              additionalProperties,
            ),
            Type.Unknown(),
          ),
        ),
      },
      additionalProperties,
    ),
    Type.Unknown(),
  ),
);

const topLevelClassifier = Schema.Compile(
  Type.Object(
    {
      schemaVersion: Type.Optional(Type.Literal(1)),
      rootPipelineId: Type.Optional(IdentifierSchema),
      pipelines: Type.Optional(
        Type.Record(IdentifierSchema, Type.Unknown(), { additionalProperties: false }),
      ),
    },
    additionalProperties,
  ),
);

export const classifyExecutionPlanSchemaFailure = (
  value: unknown,
): ExecutionPlanSchemaFailureCode => {
  const [, errors] = topLevelClassifier.Errors(value);
  if (errors.some(({ instancePath }) => instancePath === '/schemaVersion')) {
    return 'unsupported_plan_schema_version';
  }
  if (
    errors.some(
      ({ instancePath, keyword }) =>
        instancePath === '/rootPipelineId' ||
        (instancePath === '/pipelines' && keyword === 'additionalProperties'),
    ) ||
    !bindingPipelineIdClassifier.Check(value) ||
    !nodePipelineIdClassifier.Check(value)
  ) {
    return 'invalid_pipeline_id';
  }
  if (!nodeKeyClassifier.Check(value)) {
    return 'invalid_node_key';
  }
  if (!repeatBoundClassifier.Check(value)) {
    return 'invalid_repeat_bound';
  }
  return 'invalid_execution_plan';
};
