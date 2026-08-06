export interface PipelineEventSink {
  write(
    type: string,
    options?: { readonly path?: string; readonly errorCode?: string },
  ): Promise<void>;
}
