import Type from 'typebox';

export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const isPlainObject = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const JsonValueType = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref('JsonValue')),
      Type.Refine(Type.Record(Type.String(), Type.Ref('JsonValue')), isPlainObject),
    ]),
  },
  'JsonValue',
);

// TypeBox intentionally widens deeply recursive static types. JsonValue is one of the two
// reviewed recursive seams where the durable TypeScript contract remains explicit.
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueType);
