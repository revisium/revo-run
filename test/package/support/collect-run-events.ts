import type { RunEvent, RunEventCursor, RunManager } from '../../../src/index.js';

export const collectRunEvents = async (
  manager: RunManager,
  runId: string,
  after?: RunEventCursor,
): Promise<readonly RunEvent[]> => {
  const events: RunEvent[] = [];
  const input = after === undefined ? {} : { after };
  for await (const event of manager.subscribeRunEvents(runId, input)) {
    events.push(event);
  }
  return events;
};
