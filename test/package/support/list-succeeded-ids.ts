import type { ListRunsInput, RunManager } from '../../../src/index.js';

export const listSucceededIds = async (
  manager: RunManager,
  createdFrom: Date,
  createdThrough: Date,
  offset?: number,
): Promise<readonly string[]> => {
  const input: ListRunsInput = {
    statuses: ['succeeded'],
    createdFrom,
    createdThrough,
    limit: 50,
    ...(offset === undefined ? {} : { offset }),
  };
  const page = await manager.listRuns(input);
  const ids = page.items.map((item) => item.id);
  if (page.nextOffset === undefined) {
    return ids;
  }
  return [
    ...ids,
    ...(await listSucceededIds(manager, createdFrom, createdThrough, page.nextOffset)),
  ];
};
