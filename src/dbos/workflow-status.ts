import { StatusString } from '@dbos-inc/dbos-sdk';

export const isActiveWorkflowStatus = (status: string): boolean =>
  status === StatusString.DELAYED ||
  status === StatusString.ENQUEUED ||
  status === StatusString.PENDING;
