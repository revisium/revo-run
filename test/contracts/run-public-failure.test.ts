import { readFileSync } from 'node:fs';

import { Type } from 'typebox';
import { Parse } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  normalizeScriptFailure,
  pipelineFailure,
} from '../../src/contracts/normalize-run-public-failure.js';

const publicFailureSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    path: Type.Null(),
    details: Type.Null(),
  },
  { additionalProperties: false },
);
const publicErrorGoldenSchema = Type.Object(
  {
    schemaVersion: Type.Literal('rn1-public-error-golden/v1'),
    malformedScriptFailure: Type.Object(
      {
        input: Type.Object({
          code: Type.String(),
          message: Type.String(),
          details: Type.Unknown(),
        }),
        output: publicFailureSchema,
      },
      { additionalProperties: false },
    ),
    malformedPipelineFailure: Type.Object(
      { input: Type.String(), output: publicFailureSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const rawPublicErrorGolden: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/rn1/public-error-golden.json', import.meta.url), 'utf8'),
);
const publicErrorGolden = Parse(publicErrorGoldenSchema, rawPublicErrorGolden);

describe('RN1 public failure normalizer', () => {
  it('keeps only bounded script fields and deep-owned redacted details', () => {
    const source = {
      code: 'revo.script.execution.handler_failed',
      message: 'The declared operation failed.',
      details: { safe: { value: 'value' } },
      stage: 'handler',
      retryable: true,
      causes: [{ code: 'secret' }],
    };

    const normalized = normalizeScriptFailure(source);

    expect(normalized).toStrictEqual({
      code: 'revo.script.execution.handler_failed',
      message: 'The declared operation failed.',
      path: null,
      details: { safe: { value: 'value' } },
    });
    source.details.safe.value = 'mutated';
    expect(normalized.details).toStrictEqual({ safe: { value: 'value' } });
    if (normalized.details === null) {
      throw new Error('Expected retained normalized details.');
    }
    expect(Object.isFrozen(normalized.details)).toBe(true);
    const nested = normalized.details.safe;
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
      throw new Error('Expected nested normalized details.');
    }
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Reflect.set(nested, 'value', 'again')).toBe(false);
  });

  it('uses fixed fallbacks instead of retaining malformed codes or raw causes', () => {
    expect(normalizeScriptFailure(publicErrorGolden.malformedScriptFailure.input)).toStrictEqual(
      publicErrorGolden.malformedScriptFailure.output,
    );
    expect(pipelineFailure(publicErrorGolden.malformedPipelineFailure.input)).toStrictEqual(
      publicErrorGolden.malformedPipelineFailure.output,
    );
  });
});
