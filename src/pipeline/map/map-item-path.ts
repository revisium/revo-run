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

export const encodeMapItemPathSegment = (value: string): string => {
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const nextCodeUnit = value.charCodeAt(index + 1);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        encoded += encodeScalar(value.slice(index, index + 2));
        index += 1;
      } else {
        encoded += isolatedSurrogate(codeUnit);
      }
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      encoded += isolatedSurrogate(codeUnit);
      continue;
    }
    const scalar = value[index];
    if (scalar === undefined) {
      throw new Error('Map item path encoding lost a UTF-16 code unit.');
    }
    encoded += unreservedAscii.test(scalar) ? scalar : encodeScalar(scalar);
  }
  return encoded;
};
