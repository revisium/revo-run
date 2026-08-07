import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunEvent } from '../../contracts/run/run-event.js';
import type { PipelineEventDraft } from '../../pipeline/interpreter/pipeline-event-sink.js';
import { runEventStreamName } from '../dbos-names.js';

export class DbosRunEventStream {
  private sequence = 0;

  async append(eventDraft: PipelineEventDraft): Promise<void> {
    this.sequence += 1;
    const event: RunEvent = {
      cursor: String(this.sequence).padStart(16, '0'),
      ...eventDraft,
    };
    await DBOS.writeStream(runEventStreamName, event);
  }

  close(): Promise<void> {
    return DBOS.closeStream(runEventStreamName);
  }
}
