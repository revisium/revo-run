import { createHash } from 'node:crypto';

import type { CanonicalJsonSha256Digest } from '../../spec/index.js';
import { canonicalizeJson } from './canonicalize-json.js';

export const digestCanonicalJson = (value: unknown): CanonicalJsonSha256Digest =>
  `sha256:${createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex')}`;
