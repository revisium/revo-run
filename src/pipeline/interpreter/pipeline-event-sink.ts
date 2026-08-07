export interface PipelineEventDraft {
  readonly type: string;
  readonly path?: string;
  readonly errorCode?: string;
}

export interface PipelineEventSink {
  write(type: string, options?: Omit<PipelineEventDraft, 'type'>): Promise<void>;
}
