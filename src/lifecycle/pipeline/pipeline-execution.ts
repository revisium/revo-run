export interface PipelineExecution {
  executeTask(nodeKey: string): Promise<'completed' | 'failed'>;
  executeCandidate(nodeKey: string, candidate: string): Promise<'approve' | 'reject'>;
}
