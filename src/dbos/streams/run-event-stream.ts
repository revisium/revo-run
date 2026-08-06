import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunEvent } from '../../contracts/run/run-event.js';
import type { PipelineEventSink } from '../../pipeline/interpreter/pipeline-event-sink.js';
import { runEventStreamName } from '../dbos-names.js';

export class DbosRunEventStream implements PipelineEventSink {
  private sequence = 0;

  async write(type: string, options: { readonly path?: string; readonly errorCode?: string } = {}) {
    this.sequence += 1;
    const event: RunEvent = {
      cursor: String(this.sequence).padStart(16, '0'),
      type,
      ...options,
    };
    await DBOS.writeStream(runEventStreamName, event);
  }

  close(): Promise<void> {
    return DBOS.closeStream(runEventStreamName);
  }
}
