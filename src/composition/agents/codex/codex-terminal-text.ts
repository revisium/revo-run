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
  value !== undefined && /^\d$/u.test(value);
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
  /^[\p{L}\p{N}\p{M}]$/u.test(value) || String.raw`._~@+%-$\/`.includes(value);

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

const terminalUrlState = (component: UrlComponent, host: HostState): boolean =>
  component !== 'authority' || hostIsTerminal(host);

const finishWrappedOrInvalid = (lastValidExternalCloser: number | undefined): UrlRead =>
  lastValidExternalCloser === undefined
    ? { status: 'invalid' }
    : { status: 'recognized', next: lastValidExternalCloser + 1 };

type UrlComponent = 'authority' | 'path' | 'query' | 'fragment';
type UrlParserState = {
  component: UrlComponent;
  cursor: number;
  seenAt: boolean;
  userinfoViable: boolean;
  lastValidExternalCloser: number | undefined;
  host: HostState;
};

const finishUrl = (state: UrlParserState): UrlRead =>
  finishWrappedOrInvalid(state.lastValidExternalCloser);

const recordExternalCloser = (
  state: UrlParserState,
  wrapper: Wrapper | undefined,
  point: string,
): void => {
  if (point === wrapper?.closer && terminalUrlState(state.component, state.host)) {
    state.lastValidExternalCloser = state.cursor;
  }
};

const finishAtWhitespace = (state: UrlParserState, wrapper: Wrapper | undefined): UrlRead => {
  if (wrapper !== undefined) {
    return finishUrl(state);
  }
  return terminalUrlState(state.component, state.host)
    ? { status: 'recognized', next: state.cursor + 1 }
    : { status: 'invalid' };
};

const componentAfterAuthority = (point: string): Exclude<UrlComponent, 'authority'> => {
  if (point === '/') {
    return 'path';
  }
  if (point === '?') {
    return 'query';
  }
  return 'fragment';
};

const advanceIpLiteral = (
  points: readonly string[],
  state: UrlParserState,
): UrlRead | undefined => {
  if (points[state.cursor] === ']') {
    const ipStart = state.host.ipStart;
    if (ipStart === undefined || !validIpLiteral(points, ipStart, state.cursor + 1)) {
      return finishUrl(state);
    }
    state.host.mode = 'after-ip-literal';
    state.host.ipStart = undefined;
  }
  state.cursor += 1;
  return undefined;
};

const advanceAuthorityDelimiter = (point: string, state: UrlParserState): UrlRead | undefined => {
  if (!hostIsTerminal(state.host)) {
    return finishUrl(state);
  }
  state.component = componentAfterAuthority(point);
  state.cursor += 1;
  return undefined;
};

const advanceUserinfoSeparator = (state: UrlParserState): UrlRead | undefined => {
  if (state.seenAt || !state.userinfoViable) {
    return finishUrl(state);
  }
  state.seenAt = true;
  resetHostState(state.host);
  state.cursor += 1;
  return undefined;
};

const advanceAuthorityText = (
  points: readonly string[],
  state: UrlParserState,
): UrlRead | undefined => {
  const nextUserinfo = state.seenAt ? undefined : userinfoNext(points, state.cursor);
  if (!state.seenAt && nextUserinfo === undefined) {
    state.userinfoViable = false;
  }
  const nextHost = consumeHostPoint(points, state.cursor, state.host);
  if (nextHost !== undefined) {
    state.cursor = nextHost;
    return undefined;
  }
  if (!state.seenAt && state.userinfoViable && nextUserinfo !== undefined) {
    state.cursor = nextUserinfo;
    return undefined;
  }
  return finishUrl(state);
};

const advanceAuthority = (
  points: readonly string[],
  point: string,
  state: UrlParserState,
): UrlRead | undefined => {
  if (state.host.mode === 'ip-literal') {
    return advanceIpLiteral(points, state);
  }
  if (point === '/' || point === '?' || point === '#') {
    return advanceAuthorityDelimiter(point, state);
  }
  if (point === '@') {
    return advanceUserinfoSeparator(state);
  }
  return advanceAuthorityText(points, state);
};

const advanceComponent = (
  points: readonly string[],
  point: string,
  state: UrlParserState,
): UrlRead | undefined => {
  if (state.component === 'path' && point === '?') {
    state.component = 'query';
    state.cursor += 1;
    return undefined;
  }
  if (state.component !== 'fragment' && point === '#') {
    state.component = 'fragment';
    state.cursor += 1;
    return undefined;
  }
  if (point === '/' || (state.component !== 'path' && point === '?')) {
    state.cursor += 1;
    return undefined;
  }
  const next = readPchar(points, state.cursor, points.length);
  if (next === undefined) {
    return finishUrl(state);
  }
  state.cursor = next;
  return undefined;
};

const finishAtEnd = (state: UrlParserState, wrapper: Wrapper | undefined): UrlRead => {
  if (wrapper !== undefined) {
    return finishUrl(state);
  }
  return terminalUrlState(state.component, state.host)
    ? { status: 'recognized', next: state.cursor }
    : { status: 'invalid' };
};

const readUrl = (points: readonly string[], start: number): UrlRead => {
  const authorityStart = urlAuthorityStart(points, start, points.length);
  if (authorityStart === undefined) {
    return { status: 'not_url' };
  }
  const wrapper = wrapperBefore(points, start);
  const state: UrlParserState = {
    component: 'authority',
    cursor: authorityStart,
    seenAt: false,
    userinfoViable: true,
    lastValidExternalCloser: undefined,
    host: createHostState(),
  };

  while (state.cursor < points.length) {
    const point = points[state.cursor] ?? '';
    if (whitespaceOrControl(point)) {
      return finishAtWhitespace(state, wrapper);
    }
    recordExternalCloser(state, wrapper, point);
    const finished =
      state.component === 'authority'
        ? advanceAuthority(points, point, state)
        : advanceComponent(points, point, state);
    if (finished !== undefined) {
      return finished;
    }
  }
  return finishAtEnd(state, wrapper);
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

type TerminalAtomRead = Readonly<{ unsafe: true }> | Readonly<{ unsafe: false; next: number }>;

const afterRelativeAtom = (points: readonly string[], start: number): number => {
  let cursor = start + 1;
  while (cursor < points.length && atomConstituent(points[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
};

const readTerminalAtom = (points: readonly string[], start: number): TerminalAtomRead => {
  const point = points[start] ?? '';
  if (fileTokenAt(points, start) || driveAbsoluteAt(points, start)) {
    return { unsafe: true };
  }
  if (point === '\\' && points[start + 1] === '\\') {
    return { unsafe: true };
  }
  const url = readUrl(points, start);
  if (url.status === 'invalid') {
    return { unsafe: true };
  }
  if (url.status === 'recognized') {
    return { unsafe: false, next: url.next };
  }
  return point === '/'
    ? { unsafe: true }
    : { unsafe: false, next: afterRelativeAtom(points, start) };
};

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
    const atom = readTerminalAtom(points, cursor);
    if (atom.unsafe) {
      return true;
    }
    cursor = atom.next;
  }
  return false;
};
