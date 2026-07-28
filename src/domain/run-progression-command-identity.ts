export interface RunProgressionCommandIdentity {
  readonly operation: 'initialize' | 'task_outcome' | 'consensus_verdict' | 'human_gate_resolution';
  readonly nodeKey: string | null;
  readonly commandKey: string;
}
