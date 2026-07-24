import type { RunFaultMessage } from '../spec/index.js';
import type { RunFaultCode } from './run-fault-code.js';

export interface RunFault {
  readonly code: RunFaultCode;
  readonly message: RunFaultMessage;
}
