import type { JsonValue } from '../spec/index.js';
import type {
  RunStore,
  RunStoreIdempotencyIdentity,
  RunStoreIdempotencyRecord,
} from '../storage/index.js';
import type { LifecycleHandoffReceipt } from './lifecycle-handoff-receipt.js';
import { lifecycleSupport } from './lifecycle-support.js';

const {
  authorityJson,
  authorityMatches,
  boundedString,
  conflict,
  expectation,
  incumbentAuthority,
  invalid,
  loadAuthority,
  mapHandoff,
  notFound,
  sameSemanticRecordRequest,
} = lifecycleSupport;
import { lifecycleValidation } from './lifecycle-validation.js';
import type { LifecycleWriteHandoffRequest } from './lifecycle-write-handoff-request.js';
import type { LifecycleWriteHandoffResult } from './lifecycle-write-handoff-result.js';

const mapHandoffReplay = (
  record: RunStoreIdempotencyRecord,
  identity: RunStoreIdempotencyIdentity,
  stableRequest: JsonValue,
  receipt: LifecycleHandoffReceipt,
): LifecycleWriteHandoffResult => {
  if (!sameSemanticRecordRequest(record, stableRequest)) {
    return conflict({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Handoff idempotency key was reused with different semantics.',
    });
  }
  return mapHandoff({ kind: 'replayed', record }, receipt, identity);
};

export const writeHandoff = async (
  store: RunStore,
  request: LifecycleWriteHandoffRequest,
): Promise<LifecycleWriteHandoffResult> => {
  try {
    request = lifecycleValidation.handoffRequest(request);
    boundedString(request.generatedHandoffId);
    boundedString(request.idempotencyKey);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid();
    throw error;
  }
  return store.transaction(async (transaction) => {
    const identity = {
      key: request.idempotencyKey,
      operation: 'write_handoff' as const,
      runId: request.authority.runId,
      subjectId: request.authority.attemptId,
    };
    const stableRequest: JsonValue = {
      authority: authorityJson(request.authority),
      generatedHandoffId: request.generatedHandoffId,
      reason: request.reason,
      version: 1,
    };
    const replay = await transaction.getIdempotency(identity);
    if (replay.kind === 'found') {
      try {
        return mapHandoffReplay(replay.value, identity, stableRequest, {
          attemptId: request.authority.attemptId,
          handoffId: request.generatedHandoffId,
          incumbentFencingToken: request.authority.fencingToken,
        });
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) return invalid();
        throw error;
      }
    }
    const loaded = await loadAuthority(transaction, request.authority);
    if (loaded.kind === 'invalid_input') return invalid();
    if (loaded.kind === 'not_found') return notFound();
    if (!authorityMatches(request.authority, loaded.run, loaded.node, loaded.attempt)) {
      return conflict({ code: 'STALE_FENCE', message: 'Lifecycle authority is stale.' });
    }
    const receipt: LifecycleHandoffReceipt = Object.freeze({
      attemptId: loaded.attempt.id,
      handoffId: request.generatedHandoffId,
      incumbentFencingToken: loaded.attempt.fencingToken,
    });
    const stableResult: JsonValue = { ...receipt };
    const result = await transaction.commit({
      authority: incumbentAuthority(request.authority),
      expected: expectation(loaded.run, loaded.node, loaded.attempt),
      handoffId: request.generatedHandoffId,
      idempotency: {
        identity,
        request: stableRequest,
        result: stableResult,
      },
      kind: 'write_handoff',
      reason: request.reason,
    });
    try {
      return result.kind === 'replayed'
        ? mapHandoffReplay(result.record, identity, stableRequest, receipt)
        : mapHandoff(result, receipt, identity);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) return invalid();
      throw error;
    }
  });
};
