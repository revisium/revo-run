import { Error as DBOSError } from '@dbos-inc/dbos-sdk';

const stepTimeoutErrorCode = (): number => {
  const code = DBOSError.getDBOSErrorCode(
    new DBOSError.DBOSStepTimeoutError('revo-run.timeout-code', 1),
  );
  if (code === undefined) {
    throw new Error('DBOS did not expose its step timeout error code.');
  }
  return code;
};

const timeoutCode = stepTimeoutErrorCode();

export const isDbosStepTimeout = (error: unknown): boolean =>
  error instanceof Error && DBOSError.getDBOSErrorCode(error) === timeoutCode;
