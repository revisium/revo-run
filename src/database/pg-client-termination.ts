import type { Client } from 'pg';

/* eslint-disable typescript/no-unsafe-type-assertion -- pg 8.22 has no public abort API; this module is the isolated, shape-checked pinned-internal fallback. */

type DestroyableStream = Readonly<{ destroy: () => unknown }>;
type ClientWithConnectionStream = Readonly<{
  connection?: Readonly<{ stream?: Partial<DestroyableStream> }>;
}>;

/**
 * pg 8.22 can leave Client.end() waiting during a silent startup handshake.
 * Keep its pinned internal socket access isolated here: the public end() call
 * is installed first, then cancellation forces the same stream to emit end.
 */
export const forceClosePgClientSocket = (client: Client): void => {
  const candidate = client as unknown as ClientWithConnectionStream;
  const destroy = candidate.connection?.stream?.destroy;
  if (typeof destroy !== 'function') {
    throw new TypeError('Pinned pg Client connection stream is unavailable.');
  }
  destroy.call(candidate.connection?.stream);
};
