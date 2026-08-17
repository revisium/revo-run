import { describe, expect, it } from 'vitest';

import { encodeMapItemPathSegment } from '../../src/pipeline/map/map-item-path.js';
import vectors from '../fixtures/rr10/map-item-path-golden-vectors.json' with { type: 'json' };

const unreservedAscii = /^[A-Za-z0-9._~-]$/;

const decodeCanonical = (encoded: string): string => {
  let decoded = '';
  for (let index = 0; index < encoded.length;) {
    const literal = encoded[index];
    if (literal !== '%' && literal !== undefined && unreservedAscii.test(literal)) {
      decoded += literal;
      index += 1;
      continue;
    }
    if (encoded.startsWith('%u', index)) {
      const codeUnitText = encoded.slice(index + 2, index + 6);
      if (!/^[0-9A-F]{4}$/.test(codeUnitText)) {
        throw new Error('Non-canonical isolated surrogate.');
      }
      const codeUnit = Number.parseInt(codeUnitText, 16);
      if (codeUnit < 0xd800 || codeUnit > 0xdfff) {
        throw new Error('Percent-u escape is not a surrogate.');
      }
      decoded += String.fromCharCode(codeUnit);
      index += 6;
      continue;
    }
    const bytes: number[] = [];
    while (encoded[index] === '%' && !encoded.startsWith('%u', index)) {
      const byteText = encoded.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(byteText)) {
        throw new Error('Non-canonical percent byte.');
      }
      bytes.push(Number.parseInt(byteText, 16));
      index += 3;
    }
    if (bytes.length === 0) {
      throw new Error('Invalid map item path segment.');
    }
    decoded += new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  }
  if (encodeMapItemPathSegment(decoded) !== encoded) {
    throw new Error('Map item path segment is not canonical.');
  }
  return decoded;
};

const arbitraryUtf16Strings = (): readonly string[] => {
  let state = 0x5a17c9e3;
  const strings: string[] = [];
  for (let sample = 0; sample < 5_000; sample += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const length = state % 13;
    const codeUnits: number[] = [];
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      codeUnits.push(state & 0xffff);
    }
    strings.push(String.fromCharCode(...codeUnits));
  }
  return strings;
};

describe('map item display path encoding', () => {
  it.each(vectors.vectors)('matches golden vector $id', (vector) => {
    const raw = 'raw' in vector ? vector.raw : String.fromCharCode(...(vector.rawCodeUnits ?? []));
    const { encoded } = vector;
    expect(encodeMapItemPathSegment(raw)).toBe(encoded);
    expect(decodeCanonical(encoded)).toBe(raw);
  });

  it('round-trips injectively and canonically over arbitrary UTF-16 strings', () => {
    const rawByEncoding = new Map<string, string>();
    for (const raw of arbitraryUtf16Strings()) {
      const encoded = encodeMapItemPathSegment(raw);
      expect(decodeCanonical(encoded)).toBe(raw);
      const collision = rawByEncoding.get(encoded);
      expect(collision === undefined || collision === raw).toBe(true);
      rawByEncoding.set(encoded, raw);
    }
  });

  it.each(['%2f', '%41', '%u0061', ']', '%U D800', '%uD80g', '%C0%AF'])(
    'rejects non-canonical segment %s',
    (encoded) => {
      expect(() => decodeCanonical(encoded)).toThrow(/canonical|Invalid|surrogate|encoded data/);
    },
  );
});
