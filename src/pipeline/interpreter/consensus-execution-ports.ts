import type {
  ConsensusParticipantRunner,
  WaitForConsensusResolution,
} from '../consensus/consensus-participant-runner.js';

export interface ConsensusExecutionPorts {
  readonly runner: ConsensusParticipantRunner;
  readonly wait: WaitForConsensusResolution;
}
