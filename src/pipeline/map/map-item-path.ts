const unreservedAscii = /^[A-Za-z0-9._~-]$/;

const percentByte = (value: number): string =>
  `%${value.toString(16).toUpperCase().padStart(2, '0')}`;

const encodeScalar = (value: string): string => {
  let encoded = '';
  for (const byte of new TextEncoder().encode(value)) {
    encoded += percentByte(byte);
  }
  return encoded;
};

const isolatedSurrogate = (codeUnit: number): string =>
  `%u${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;

const encodeCodePoint = (codePoint: number): string => {
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return isolatedSurrogate(codePoint);
  }
  const scalar = String.fromCodePoint(codePoint);
  if (unreservedAscii.test(scalar)) {
    return scalar;
  }
  return encodeScalar(scalar);
};

export const encodeMapItemPathSegment = (value: string): string => {
  let encoded = '';
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      throw new Error('Map item path encoding lost a UTF-16 code unit.');
    }
    encoded += encodeCodePoint(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return encoded;
};
