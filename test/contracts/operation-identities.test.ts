import { describe, expect, it } from 'vitest';

import {
  attemptId,
  attemptDispatchArbitrationIdentityToken,
  attemptDispatchArbitrationWorkflowId,
  gateId,
  operationId,
  operationReceiptId,
  recoveryReceiptId,
  retryStartReceiptId,
  waitId,
} from '../../src/operations/identities.js';

describe('RN1 operation identities', () => {
  it('uses a distinct durable transport key for a terminal observation and recovery relay', () => {
    const operation = operationId('rn1-receipts', 'script');

    expect(operationReceiptId('rn1-receipts', operation)).not.toBe(
      recoveryReceiptId('rn1-receipts', operation),
    );
  });

  it('gives every retry ordinal an independent terminal-observation receipt', () => {
    const operation = operationId('rn1-retry-receipts', 'script');

    expect(operationReceiptId('rn1-retry-receipts', operation, 1)).not.toBe(
      operationReceiptId('rn1-retry-receipts', operation, 2),
    );
  });

  it('uses a distinct durable retry-start receipt for each next ordinal', () => {
    const runId = 'rn1-retry-start-receipts';
    const operation = operationId(runId, 'script');

    expect(retryStartReceiptId(runId, operation, 2)).not.toBe(
      operationReceiptId(runId, operation, 2),
    );
    expect(retryStartReceiptId(runId, operation, 2)).not.toBe(
      recoveryReceiptId(runId, operation, 2),
    );
    expect(retryStartReceiptId(runId, operation, 2)).not.toBe(
      retryStartReceiptId(runId, operation, 3),
    );
  });

  it('derives the frozen operation, attempt, wait, and gate vectors from one command key', () => {
    const runId = 'run_01K4Q7T9R2M8';
    const commandKey = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

    const operation = operationId(runId, commandKey);
    expect(operation).toBe('op_4xTecXjPzS1j7OhNJkmAP41H-ShNvfm3MCoUBuroHLE');
    expect(attemptId(operation, 1)).toBe('att_wPF6CbXAP4NGHxVzPOVbnzU9-Zz1MqK-M9bp8j37nr4');
    expect(waitId(runId, commandKey)).toBe('wait_4Ox9qTy3H3iWBkWT4pjSkXv7qIQQLFhwTwta8qAQZks');
    expect(gateId(runId, commandKey)).toBe('gate_lJtBfM7sdM0vQ7KF7pap1Y-UolrD3w8lZ7vDc4JCTIc');
    expect(attemptDispatchArbitrationWorkflowId(operation, attemptId(operation, 1))).toBe(
      'arg_1AYfhhnkIb-5R23Lo2HR70Fxi99-EZ7JydeoE3FtMHc',
    );
    expect(attemptDispatchArbitrationIdentityToken(operation, attemptId(operation, 1))).toBe(
      'art_rZEBHiold_3q0zF42bK5ni4wfg5tYOwG_7DTSyzCqWo',
    );
  });
});
