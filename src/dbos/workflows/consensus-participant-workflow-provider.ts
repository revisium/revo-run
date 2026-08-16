import type { ConsensusParticipantWorkflow } from './consensus-participant-workflow.js';

export class ConsensusParticipantWorkflowProvider {
  private workflow: ConsensusParticipantWorkflow | undefined;

  register(workflow: ConsensusParticipantWorkflow): void {
    if (this.workflow !== undefined) {
      throw new Error('Consensus participant workflow is already registered.');
    }
    this.workflow = workflow;
  }

  get(): ConsensusParticipantWorkflow {
    if (this.workflow === undefined) {
      throw new Error('Consensus participant workflow is not registered.');
    }
    return this.workflow;
  }
}
