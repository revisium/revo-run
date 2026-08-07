import { describe, expect, it } from 'vitest';

import { isActiveWorkflowStatus } from '../../src/dbos/workflow-status.js';

describe('DBOS workflow status', () => {
  it.each(['DELAYED', 'ENQUEUED', 'PENDING'])('treats %s as active', (status) => {
    expect(isActiveWorkflowStatus(status)).toBe(true);
  });

  it.each(['CANCELLED', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'SUCCESS'])(
    'treats %s as terminal',
    (status) => {
      expect(isActiveWorkflowStatus(status)).toBe(false);
    },
  );
});
