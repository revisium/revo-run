/**
 * Controlled terminal paths wake scopes with a durable directive. This coarse timeout only
 * detects an orphaned waiter after an unrecoverable coordinator failure. At most one timeout,
 * its durable deadline, and one status lookup are recorded per idle waiter per day.
 */
export const orphanHealthCheckSeconds = 24 * 60 * 60;
