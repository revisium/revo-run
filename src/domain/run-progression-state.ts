import type { RunProgressionCandidateVerdict } from './run-progression-candidate-verdict.js';
import type { RunProgressionCommandReceipt } from './run-progression-command-receipt.js';
import type { RunProgressionGateResolution } from './run-progression-gate-resolution.js';
import type { RunProgressionTerminal } from './run-progression-terminal.js';
import type { RunProgressionValueRecord } from './run-progression-value-record.js';

type ActiveNode =
  | { readonly nodeKey: string; readonly state: 'enabled' }
  | { readonly nodeKey: string; readonly state: 'terminal'; readonly outcome: string };

type TerminalNode =
  | { readonly nodeKey: string; readonly state: 'terminal'; readonly outcome: string }
  | {
      readonly nodeKey: string;
      readonly state: 'retired';
      readonly terminal: RunProgressionTerminal;
    };

type ProgressionValues = {
  readonly schemaVersion: 1;
  readonly occurrenceKey: string;
  readonly values: readonly RunProgressionValueRecord[];
  readonly candidateVerdicts: readonly RunProgressionCandidateVerdict[];
  readonly gateResolutions: readonly RunProgressionGateResolution[];
  readonly commandReceipts: readonly RunProgressionCommandReceipt[];
};

export type RunProgressionState =
  | {
      readonly schemaVersion: 1;
      readonly occurrenceKey: string;
      readonly phase: 'uninitialized';
      readonly values: readonly [];
      readonly nodes: readonly [];
      readonly candidateVerdicts: readonly [];
      readonly gateResolutions: readonly [];
      readonly commandReceipts: readonly [];
      readonly terminal: null;
    }
  | (ProgressionValues & {
      readonly phase: 'active';
      readonly nodes: readonly ActiveNode[];
      readonly terminal: null;
    })
  | (ProgressionValues & {
      readonly phase: 'terminal';
      readonly nodes: readonly TerminalNode[];
      readonly terminal: RunProgressionTerminal;
    });
