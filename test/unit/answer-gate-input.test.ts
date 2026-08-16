import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { isAnswerGateInput } from '../../src/validation/run-command.validator.js';

const commandId = `cmd_${randomUUID()}`;
const gateInstanceId = `ni1_${'A'.repeat(43)}`;

const validInput = {
  runId: 'run-1',
  gateInstanceId,
  answer: 'approved',
  actorId: 'alice',
  actorGroups: ['approvers'],
  commandId,
};

describe('AnswerGateInput schema', () => {
  it('accepts a closed caller-supplied answer', () => {
    expect(isAnswerGateInput(validInput)).toBe(true);
  });

  it('rejects additional properties', () => {
    expect(isAnswerGateInput({ ...validInput, extra: true })).toBe(false);
  });

  it('rejects a non-v4 command id', () => {
    expect(isAnswerGateInput({ ...validInput, commandId: 'gate-answer-1' })).toBe(false);
  });

  it('rejects a malformed gate instance id', () => {
    expect(isAnswerGateInput({ ...validInput, gateInstanceId: 'main/approval' })).toBe(false);
  });

  it('rejects a nested malformed actor group', () => {
    expect(isAnswerGateInput({ ...validInput, actorGroups: ['ok', ''] })).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { actorId: _actorId, ...withoutActor } = validInput;
    expect(isAnswerGateInput(withoutActor)).toBe(false);
  });
});
