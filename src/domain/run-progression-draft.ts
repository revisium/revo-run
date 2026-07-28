import { canonicalizeJson } from '../policy/index.js';
import type { Attempt } from './attempt.js';
import { createAttempt } from './create-attempt.js';
import { createRunNodeInstance } from './create-run-node-instance.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunOutput } from './run-output.js';
import type { RunProgressionProjection } from './run-progression-projection.js';

const same = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

export const createRunProgressionDraft = (base: RunProgressionProjection) => {
  const baseNodes = new Map(base.nodes.map((value) => [value.id, value]));
  const baseAttempts = new Map(base.attempts.map((value) => [value.id, value]));
  const nodes = new Map(base.nodes.map((value) => [value.id, value]));
  const attempts = new Map(base.attempts.map((value) => [value.id, value]));
  const outputs = new Map(base.outputs.map((value) => [value.id, value]));
  const nodeDeltas = new Map<string, RunNodeInstance>();
  const attemptDeltas = new Map<string, Attempt>();
  const outputDeltas = new Map<string, RunOutput>();

  const projection = (): RunProgressionProjection => ({
    attempts: [...attempts.values()],
    nodes: [...nodes.values()],
    outputs: [...outputs.values()],
    run: base.run,
  });
  const recordNode = (value: RunNodeInstance): void => {
    if (nodeDeltas.has(value.id) && same(nodeDeltas.get(value.id), value)) {
      throw new TypeError('Run progression node step does not evolve its draft.');
    }
    nodes.set(value.id, value);
    nodeDeltas.set(value.id, value);
  };
  const recordAttempt = (value: Attempt): void => {
    if (attemptDeltas.has(value.id) && same(attemptDeltas.get(value.id), value)) {
      throw new TypeError('Run progression Attempt step does not evolve its draft.');
    }
    attempts.set(value.id, value);
    attemptDeltas.set(value.id, value);
  };
  const recordOutput = (value: RunOutput): void => {
    const prior = outputs.get(value.id);
    if (prior !== undefined || outputDeltas.has(value.id)) {
      throw new TypeError('Run progression immutable output is duplicated.');
    }
    outputs.set(value.id, value);
    outputDeltas.set(value.id, value);
  };

  return Object.freeze({
    attemptDeltas: () =>
      Object.freeze(
        [...attemptDeltas.values()].map((value) =>
          createAttempt({
            ...value,
            revision: (baseAttempts.get(value.id)?.revision ?? -1) + 1,
          }),
        ),
      ),
    nodeDeltas: () =>
      Object.freeze(
        [...nodeDeltas.values()].map((value) =>
          createRunNodeInstance({
            ...value,
            revision: (baseNodes.get(value.id)?.revision ?? -1) + 1,
          }),
        ),
      ),
    outputDeltas: () => Object.freeze([...outputDeltas.values()]),
    projection,
    recordAttempt,
    recordNode,
    recordOutput,
  });
};
