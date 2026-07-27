export interface LocalClock {
  /** Process-local coordination time. Never durable lease or fence authority. */
  now(): number;
}
