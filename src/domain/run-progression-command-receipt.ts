import type { RunProgressionAppliedReceipt } from './run-progression-applied-receipt.js';
import type { RunProgressionCommandIdentity } from './run-progression-command-identity.js';
import type { RunProgressionHostAttachment } from './run-progression-host-attachment.js';
import type { RunProgressionSemanticRequest } from './run-progression-semantic-request.js';

export interface RunProgressionCommandReceipt {
  readonly identity: RunProgressionCommandIdentity;
  readonly semanticRequest: RunProgressionSemanticRequest;
  readonly hostAttachment: RunProgressionHostAttachment;
  readonly result: RunProgressionAppliedReceipt;
}
