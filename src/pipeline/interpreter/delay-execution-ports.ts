export type DelayWaitResult = 'cancelled' | 'elapsed' | 'failed';

export type WaitForDelay = (durationMs: number) => Promise<DelayWaitResult>;
