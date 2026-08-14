import { createHash, randomUUID } from 'node:crypto';

export type TestProcessKind =
  | 'admin-cancellation'
  | 'effect-recovery-spike'
  | 'recovery'
  | 'run-observer';

const testRunNonce = randomUUID();

export const testProcessApplicationVersion = (kind: TestProcessKind, lineageId: string): string => {
  const digest = createHash('sha256')
    .update(testRunNonce)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(lineageId)
    .digest('hex')
    .slice(0, 24);
  return `revo-run-test-${kind}-${digest}`;
};
