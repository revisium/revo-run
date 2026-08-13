import { DBOS } from '@dbos-inc/dbos-sdk';
import type { GetWorkflowsInput, WorkflowStatus, WorkflowStatusString } from '@dbos-inc/dbos-sdk';

import type { ListRunsInput, RunPage } from '../../contracts/run/list-runs.js';
import type { RunStatus, RunSummary } from '../../contracts/run/run.js';
import { runWorkflowName, runWorkflowV2Name } from '../dbos-names.js';
import { mapRunSummary, RunOwnershipError } from './map-run-snapshot.js';

const defaultLimit = 50;
const maximumDbosPageSize = 100;

interface OwnedRunRow {
  readonly summary: RunSummary;
  readonly nextRawOffset: number;
}

const dbosStatuses = (
  statuses: readonly RunStatus[] | undefined,
): WorkflowStatusString[] | undefined => {
  if (statuses === undefined) {
    return undefined;
  }
  return [
    ...new Set(
      statuses.flatMap((status) => {
        switch (status) {
          case 'pending':
            return ['ENQUEUED', 'DELAYED'] as const;
          case 'running':
            return ['PENDING'] as const;
          case 'succeeded':
            return ['SUCCESS'] as const;
          case 'failed':
            return ['ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'SUCCESS'] as const;
          case 'cancelled':
            return ['CANCELLED', 'SUCCESS'] as const;
          default:
            status satisfies never;
            return [];
        }
      }),
    ),
  ];
};

const matchesStatus = (summary: RunSummary, statuses: readonly RunStatus[] | undefined): boolean =>
  statuses === undefined || statuses.includes(summary.status);

const knownRunWorkflowName = (workflowName: string): string | undefined => {
  if (workflowName === runWorkflowName) {
    return runWorkflowName;
  }
  if (workflowName === runWorkflowV2Name) {
    return runWorkflowV2Name;
  }
  return undefined;
};

const ownedRunSummary = (row: WorkflowStatus): RunSummary | undefined => {
  const workflowName = knownRunWorkflowName(row.workflowName);
  if (workflowName === undefined) {
    return undefined;
  }
  try {
    return mapRunSummary(row, workflowName);
  } catch (error) {
    if (error instanceof RunOwnershipError) {
      return undefined;
    }
    throw error;
  }
};

const queryFrom = (input: ListRunsInput): GetWorkflowsInput => {
  const status = dbosStatuses(input.statuses);
  return {
    workflow_id_prefix: 'rr:run:v1:',
    ...(status === undefined ? {} : { status }),
    ...(input.createdFrom === undefined ? {} : { startTime: input.createdFrom.toISOString() }),
    ...(input.createdThrough === undefined ? {} : { endTime: input.createdThrough.toISOString() }),
    sortDesc: true,
    loadInput: true,
    loadOutput: true,
  };
};

const queryRunRows = (
  input: ListRunsInput,
  rawOffset: number,
  limit: number,
): Promise<WorkflowStatus[]> =>
  DBOS.listWorkflows({ ...queryFrom(input), offset: rawOffset, limit });

const collectOwnedRows = (
  rows: readonly WorkflowStatus[],
  input: ListRunsInput,
  rawOffset: number,
  limit: number,
  ownedRows: OwnedRunRow[],
): number => {
  let nextRawOffset = rawOffset;
  for (const row of rows) {
    nextRawOffset += 1;
    const summary = ownedRunSummary(row);
    if (summary !== undefined && matchesStatus(summary, input.statuses)) {
      ownedRows.push({ summary, nextRawOffset });
    }
    if (ownedRows.length > limit) {
      break;
    }
  }
  return nextRawOffset;
};

const scanUntilOwnedRunLookahead = async (
  input: ListRunsInput,
  rawOffset: number,
  limit: number,
  ownedRows: OwnedRunRow[] = [],
): Promise<readonly OwnedRunRow[]> => {
  if (ownedRows.length > limit) {
    return ownedRows;
  }

  const requested = Math.min(maximumDbosPageSize, limit + 1 - ownedRows.length);
  const rows = await queryRunRows(input, rawOffset, requested);
  if (rows.length === 0) {
    return ownedRows;
  }

  const nextRawOffset = collectOwnedRows(rows, input, rawOffset, limit, ownedRows);

  return rows.length === requested && ownedRows.length <= limit
    ? scanUntilOwnedRunLookahead(input, nextRawOffset, limit, ownedRows)
    : ownedRows;
};

const assembleRunPage = (ownedRows: readonly OwnedRunRow[], limit: number): RunPage => {
  const pageRows = ownedRows.slice(0, limit);
  const items = pageRows.map(({ summary }) => summary);
  if (ownedRows.length <= limit) {
    return { items };
  }
  const last = pageRows.at(-1);
  if (last === undefined) {
    throw new Error('Run page continuation has no preceding item.');
  }
  return { items, nextOffset: last.nextRawOffset };
};

export const loadRunPage = async (input: ListRunsInput): Promise<RunPage> => {
  const limit = input.limit ?? defaultLimit;
  const ownedRows = await scanUntilOwnedRunLookahead(input, input.offset ?? 0, limit);
  return assembleRunPage(ownedRows, limit);
};
