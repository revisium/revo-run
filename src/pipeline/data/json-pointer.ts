import type { JsonValue } from '../../contracts/json-value.js';

export type JsonPointerResult =
  | { readonly found: true; readonly value: JsonValue }
  | { readonly found: false };

const decodeToken = (token: string): string => token.replaceAll('~1', '/').replaceAll('~0', '~');

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const isJsonRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !isJsonArray(value);

const childValue = (value: JsonValue, token: string): JsonPointerResult => {
  if (isJsonArray(value)) {
    if (!/^(?:0|[1-9]\d*)$/.test(token)) {
      return { found: false };
    }

    const child = value[Number(token)];
    return child === undefined ? { found: false } : { found: true, value: child };
  }

  if (!isJsonRecord(value) || !Object.hasOwn(value, token)) {
    return { found: false };
  }

  const child = value[token];
  return child === undefined ? { found: false } : { found: true, value: child };
};

export const readJsonPointer = (value: JsonValue, pointer: string): JsonPointerResult => {
  if (pointer === '') {
    return { found: true, value };
  }

  let current = value;
  for (const token of pointer.slice(1).split('/').map(decodeToken)) {
    const child = childValue(current, token);
    if (!child.found) {
      return child;
    }
    current = child.value;
  }

  return { found: true, value: current };
};
