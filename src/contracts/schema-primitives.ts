import Type from 'typebox';

const identifierSegmentPattern = '[A-Za-z][A-Za-z0-9._-]{0,127}';

export const identifierPattern = `^${identifierSegmentPattern}$`;
export const pipelineNodePathPattern = `^${identifierSegmentPattern}(?:/${identifierSegmentPattern})*$`;

export const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: identifierPattern,
});

export const NonEmptyStringSchema = Type.String({ minLength: 1 });

export const PipelineNodePathSchema = Type.String({ pattern: pipelineNodePathPattern });

export const PositiveSafeIntegerSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });

export const JsonPointerSchema = Type.String({
  pattern: '^(?:|(?:/(?:[^~/]|~[01])*)+)$',
});
