export interface RunProgressionCandidateVerdict {
  readonly nodeKey: string;
  readonly candidateKey: string;
  readonly verdict: 'approve' | 'reject' | 'abstain';
}
