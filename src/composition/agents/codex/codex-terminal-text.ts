import { isIP } from 'node:net';

type Wrapper = Readonly<{ opener: string; closer: string }>;
type UrlRead =
  | Readonly<{ status: 'recognized'; next: number }>
  | Readonly<{ status: 'not_url' | 'invalid' }>;

const wrapperClosers = new Map<string, string>([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ["'", "'"],
  ['"', '"'],
  ['`', '`'],
  ['«', '»'],
]);

const asciiLetter = (value: string | undefined): boolean =>
  value !== undefined && /^[A-Za-z]$/u.test(value);
const asciiDigit = (value: string | undefined): boolean =>
  value !== undefined && /^[0-9]$/u.test(value);
const asciiHex = (value: string | undefined): boolean =>
  value !== undefined && /^[0-9A-Fa-f]$/u.test(value);
const asciiSchemeCharacter = (value: string | undefined): boolean =>
  asciiLetter(value) || asciiDigit(value) || value === '+' || value === '-' || value === '.';
const unreserved = (value: string | undefined): boolean =>
  asciiLetter(value) ||
  asciiDigit(value) ||
  value === '-' ||
  value === '.' ||
  value === '_' ||
  value === '~';
const subdelimiter = (value: string | undefined): boolean =>
  value !== undefined && "!$&'()*+,;=".includes(value);
const whitespaceOrControl = (value: string | undefined): boolean =>
  value !== undefined && /^[\p{Z}\p{C}]$/u.test(value);
const atomConstituent = (value: string): boolean =>
  /^[\p{L}\p{N}\p{M}]$/u.test(value) || '._~@+%-$\\/'.includes(value);

const wrapperBefore = (points: readonly string[], start: number): Wrapper | undefined => {
  const opener = points[start - 1];
  const closer = opener === undefined ? undefined : wrapperClosers.get(opener);
  return opener === undefined || closer === undefined ? undefined : { opener, closer };
};

const readPct = (points: readonly string[], start: number, end: number): number | undefined =>
  start + 2 < end &&
  points[start] === '%' &&
  asciiHex(points[start + 1]) &&
  asciiHex(points[start + 2])
    ? start + 3
    : undefined;

const validIpvFuture = (points: readonly string[], start: number, end: number): boolean => {
  if (points[start]?.toLowerCase() !== 'v') {
    return false;
  }
  let cursor = start + 1;
  const firstHex = cursor;
  while (cursor < end && asciiHex(points[cursor])) {
    cursor += 1;
  }
  if (cursor === firstHex || points[cursor] !== '.') {
    return false;
  }
  cursor += 1;
  const firstAddressPoint = cursor;
  while (
    cursor < end &&
    (unreserved(points[cursor]) || subdelimiter(points[cursor]) || points[cursor] === ':')
  ) {
    cursor += 1;
  }
  return cursor > firstAddressPoint && cursor === end;
};

const validIpLiteral = (points: readonly string[], start: number, end: number): boolean => {
  if (points[start] !== '[' || points[end - 1] !== ']') {
    return false;
  }
  const innerStart = start + 1;
  const innerEnd = end - 1;
  const inner = points.slice(innerStart, innerEnd).join('');
  return isIP(inner) === 6 || validIpvFuture(points, innerStart, innerEnd);
};

type HostState = {
  mode: 'reg-name' | 'ip-literal' | 'after-ip-literal' | 'port';
  viable: boolean;
  nonempty: boolean;
  ipStart: number | undefined;
};

const createHostState = (): HostState => ({
  mode: 'reg-name',
  viable: true,
  nonempty: false,
  ipStart: undefined,
});

const resetHostState = (host: HostState): void => {
  host.mode = 'reg-name';
  host.viable = true;
  host.nonempty = false;
  host.ipStart = undefined;
};

const hostIsTerminal = (host: HostState): boolean =>
  host.viable &&
  ((host.mode === 'reg-name' && host.nonempty) ||
    host.mode === 'after-ip-literal' ||
    host.mode === 'port');

const userinfoNext = (points: readonly string[], cursor: number): number | undefined => {
  const point = points[cursor];
  if (point === '%') {
    return readPct(points, cursor, points.length);
  }
  return unreserved(point) || subdelimiter(point) || point === ':' ? cursor + 1 : undefined;
};

const consumeHostPoint = (
  points: readonly string[],
  cursor: number,
  host: HostState,
): number | undefined => {
  const point = points[cursor];
  if (!host.viable) {
    return undefined;
  }
  if (host.mode === 'after-ip-literal') {
    if (point === ':') {
      host.mode = 'port';
      return cursor + 1;
    }
    host.viable = false;
    return undefined;
  }
  if (host.mode === 'port') {
    if (asciiDigit(point)) {
      return cursor + 1;
    }
    host.viable = false;
    return undefined;
  }
  if (point === '[' && !host.nonempty) {
    host.mode = 'ip-literal';
    host.ipStart = cursor;
    return cursor + 1;
  }
  if (point === '%') {
    const next = readPct(points, cursor, points.length);
    if (next !== undefined) {
      host.nonempty = true;
      return next;
    }
    host.viable = false;
    return undefined;
  }
  if (unreserved(point) || subdelimiter(point)) {
    host.nonempty = true;
    return cursor + 1;
  }
  if (point === ':' && host.nonempty) {
    host.mode = 'port';
    return cursor + 1;
  }
  host.viable = false;
  return undefined;
};

const urlAuthorityStart = (
  points: readonly string[],
  start: number,
  end: number,
): number | undefined => {
  if (points[start] === '/' && points[start + 1] === '/' && start + 2 <= end) {
    return start + 2;
  }
  if (!asciiLetter(points[start])) {
    return undefined;
  }
  let cursor = start + 1;
  while (cursor < end && asciiSchemeCharacter(points[cursor])) {
    cursor += 1;
  }
  return cursor + 2 < end &&
    points[cursor] === ':' &&
    points[cursor + 1] === '/' &&
    points[cursor + 2] === '/'
    ? cursor + 3
    : undefined;
};

const readPchar = (points: readonly string[], start: number, end: number): number | undefined => {
  if (points[start] === '%') {
    return readPct(points, start, end);
  }
  return unreserved(points[start]) ||
    subdelimiter(points[start]) ||
    points[start] === ':' ||
    points[start] === '@'
    ? start + 1
    : undefined;
};

const terminalUrlState = (
  component: 'authority' | 'path' | 'query' | 'fragment',
  host: HostState,
): boolean => component !== 'authority' || hostIsTerminal(host);

const finishWrappedOrInvalid = (lastValidExternalCloser: number | undefined): UrlRead =>
  lastValidExternalCloser === undefined
    ? { status: 'invalid' }
    : { status: 'recognized', next: lastValidExternalCloser + 1 };

const readUrl = (points: readonly string[], start: number): UrlRead => {
  const authorityStart = urlAuthorityStart(points, start, points.length);
  if (authorityStart === undefined) {
    return { status: 'not_url' };
  }
  const wrapper = wrapperBefore(points, start);
  const host = createHostState();
  let component: 'authority' | 'path' | 'query' | 'fragment' = 'authority';
  let cursor = authorityStart;
  let seenAt = false;
  let userinfoViable = true;
  let lastValidExternalCloser: number | undefined;

  while (cursor < points.length) {
    const point = points[cursor] ?? '';
    if (whitespaceOrControl(point)) {
      if (wrapper !== undefined) {
        return finishWrappedOrInvalid(lastValidExternalCloser);
      }
      return terminalUrlState(component, host)
        ? { status: 'recognized', next: cursor + 1 }
        : { status: 'invalid' };
    }

    if (wrapper !== undefined && point === wrapper.closer && terminalUrlState(component, host)) {
      lastValidExternalCloser = cursor;
    }

    if (component === 'authority') {
      if (host.mode === 'ip-literal') {
        if (point === ']') {
          const ipStart = host.ipStart;
          if (ipStart === undefined || !validIpLiteral(points, ipStart, cursor + 1)) {
            return finishWrappedOrInvalid(lastValidExternalCloser);
          }
          host.mode = 'after-ip-literal';
          host.ipStart = undefined;
        }
        cursor += 1;
        continue;
      }

      if (point === '/' || point === '?' || point === '#') {
        if (!hostIsTerminal(host)) {
          return finishWrappedOrInvalid(lastValidExternalCloser);
        }
        component = point === '/' ? 'path' : point === '?' ? 'query' : 'fragment';
        cursor += 1;
        continue;
      }

      if (point === '@') {
        if (seenAt || !userinfoViable) {
          return finishWrappedOrInvalid(lastValidExternalCloser);
        }
        seenAt = true;
        resetHostState(host);
        cursor += 1;
        continue;
      }

      const nextUserinfo = seenAt ? undefined : userinfoNext(points, cursor);
      if (!seenAt && nextUserinfo === undefined) {
        userinfoViable = false;
      }
      const nextHost = consumeHostPoint(points, cursor, host);
      if (nextHost !== undefined) {
        cursor = nextHost;
        continue;
      }
      if (!seenAt && userinfoViable && nextUserinfo !== undefined) {
        cursor = nextUserinfo;
        continue;
      }
      return finishWrappedOrInvalid(lastValidExternalCloser);
    }

    if (component === 'path' && point === '?') {
      component = 'query';
      cursor += 1;
      continue;
    }
    if (component !== 'fragment' && point === '#') {
      component = 'fragment';
      cursor += 1;
      continue;
    }
    if (point === '/' || (component !== 'path' && point === '?')) {
      cursor += 1;
      continue;
    }
    const next = readPchar(points, cursor, points.length);
    if (next === undefined) {
      return finishWrappedOrInvalid(lastValidExternalCloser);
    }
    cursor = next;
  }

  if (wrapper !== undefined) {
    return finishWrappedOrInvalid(lastValidExternalCloser);
  }
  return terminalUrlState(component, host)
    ? { status: 'recognized', next: cursor }
    : { status: 'invalid' };
};

const fileTokenAt = (points: readonly string[], start: number): boolean =>
  points
    .slice(start, start + 5)
    .join('')
    .toLowerCase() === 'file:';
const driveAbsoluteAt = (points: readonly string[], start: number): boolean =>
  asciiLetter(points[start]) &&
  points[start + 1] === ':' &&
  (points[start + 2] === '/' || points[start + 2] === '\\');

/** Returns true when terminal text contains an absolute filesystem-shaped lexical token. */
export const containsUnsafeTerminalPathToken = (value: string): boolean => {
  const points = Array.from(value);
  let cursor = 0;
  while (cursor < points.length) {
    const point = points[cursor] ?? '';
    if (!atomConstituent(point)) {
      cursor += 1;
      continue;
    }
    if (fileTokenAt(points, cursor) || driveAbsoluteAt(points, cursor)) {
      return true;
    }
    if (point === '\\' && points[cursor + 1] === '\\') {
      return true;
    }
    const url = readUrl(points, cursor);
    if (url.status === 'invalid') {
      return true;
    }
    if (url.status === 'recognized') {
      cursor = url.next;
      continue;
    }
    if (point === '/') {
      return true;
    }
    cursor += 1;
    while (cursor < points.length && atomConstituent(points[cursor] ?? '')) {
      cursor += 1;
    }
  }
  return false;
};
