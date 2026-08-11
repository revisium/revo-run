export interface WaitForTerminalInput {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
