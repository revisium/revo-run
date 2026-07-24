# Evidence Store v1

- Status: Stable port contract; no implementation is shipped.

Evidence is append-only and contiguous from sequence 1. `createAttempt(record,
initialEvent)` atomically creates accepted revision 1 / sequence 1. Its only
later writable operation is:

```text
transition({ attemptId, expectedRevision, expectedNextSequence, event,
             proposedRecord }) -> committed(snapshot) | conflict(snapshot)
```

In one transaction it requires persisted revision and expected sequence to match,
validates the reducer transition from persisted record and event, appends the
event, and writes reducer-produced record state/revision/sequence/timestamps,
provider coordinate, and terminal result. The proposed record is not
caller-authoritative. Readers see event and next record together or neither.

Uniqueness covers `(runId,commandId)`, `(runId,attemptId)`, `(attemptId,sequence)`,
and `eventId`. A global cursor is opaque monotonic commit order for recovery
scans only. Provider observations are unique by `(attemptId, providerInvocationId,
providerEventId)` and bind `safeProjectionDigest`: exact replay returns the
original event/snapshot without a sequence; changed digest rejects
`revo.run.provider_observation_conflict` and appends nothing. Only the future
controller receives this writable port.

## Exact port and acceptance rules

`createAttempt(record, acceptedEvent)` atomically creates record revision 1,
sequence 1, and unique `(runId,commandId)`, `(runId,attemptId)`, eventId, and
`(attemptId,sequence)`. Exact Start replay returns Snapshot; a changed request
digest returns Conflict. The sole later writable operation is:

```text
transition({attemptId, expectedRevision, expectedNextSequence, event, proposedRecord})
  -> committed(SnapshotV1) | conflict(ConflictV1)
```

It requires revision equality and `expectedNextSequence == lastSequence + 1`,
validates the pure reducer against persisted record/event, appends the event, and
writes only reducer-produced next state/revision/sequence/timestamps/coordinate/
terminal in the same transaction. Readers see record and event together or
neither; proposedRecord is not caller authority. `read(attemptId)` returns
Snapshot or contract error `attempt_not_found`. `scanNonTerminal({afterCursor,
limit})`, with limit 1..500, returns ordered `{items,nextCursor}` by opaque
monotonic cursor; restarted scans may repeat items, so recovery is idempotent by
attempt/revision.

Provider-observation uniqueness is `(attemptId,providerInvocationId,
providerEventId)` bound to safeProjectionDigest in that transaction. Same
key/digest returns the original Snapshot/event with no new sequence; changed
digest returns provider-observation Conflict and appends nothing. Concurrent
duplicates serialize: one commit and all exact duplicates see the original
Snapshot. Contract tests must cover create/replay/mismatch, missing read, cursor
page/repeat tolerance, revision/sequence conflict, no partial visibility,
concurrent duplicate observation, and changed-digest rejection.
