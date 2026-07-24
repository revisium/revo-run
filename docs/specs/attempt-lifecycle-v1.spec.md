# Attempt Lifecycle v1

- Status: Stable contract; reducer/controller implementation is deferred.

`AttemptRecordV1` contains identity, request digest, exact provider pin, state,
revision, last sequence, timestamps, nullable provider coordinate, and nullable
terminal result. States are `accepted`, `preparing`, `running`,
`cancellation_requested`, `cancelling`, `succeeded`, `failed`, `cancelled`, and
`recovery_blocked`. The final four are terminal and immutable.

Start creates `accepted`; controller preparation advances it; durable provider
coordinate commits `running`; rejected start becomes `failed`. In `accepted`,
cancel goes directly to `cancelled` and never invokes a provider. Before a
coordinate, cancellation records intent and only reaches `cancelled` after a
proven no-spawn abort. Uncertain spawn is `recovery_blocked`. After coordinate,
cancel records intent, dispatches exactly one bounded cancel, then records
`cancel_dispatched` and enters `cancelling`.

Terminal observation and cancellation race through CAS: terminal committed first
wins; cancellation committed first blocks a new start but permits the later true
terminal observation. A late callback after direct cancellation cannot reopen an
attempt. Recovery uses stored coordinate/exact pin; unavailable or uncertain
reconciliation fails closed to `recovery_blocked`.

Retry is a fact, not a scheduler: terminal kind, nullable provider failure code,
timeout/cancellation flags, confirmed-terminal flag, recovery confidence, and
`retryable|not_retryable|unknown`. A caller/Pipeline creates an explicitly linked
new attempt; the kernel never retries autonomously.

## Exact CAS, crash, and recovery table

| Current                 | input                      | atomic durable outcome                             |
| ----------------------- | -------------------------- | -------------------------------------------------- |
| absent                  | valid start                | accepted / accepted                                |
| accepted                | cancel                     | completed(cancelled) / cancelled; no provider call |
| accepted                | begin                      | prepare_started / preparing                        |
| preparing no coordinate | proven pre-spawn cancel    | completed(cancelled), coordinate null              |
| preparing no coordinate | cancel + possible spawn    | cancellation_requested then recovery_blocked       |
| preparing               | start rejects before spawn | failed terminal                                    |
| preparing               | coordinate accepted        | provider_started / running                         |
| running                 | terminal observation       | terminal + completed / terminal                    |
| running                 | cancel                     | cancellation_requested                             |
| cancellation_requested  | dispatch accepted          | cancel_dispatched / cancelling exactly once        |
| cancelling              | true terminal              | terminal + completed / true terminal               |
| restart nonterminal     | verified running/terminal  | recovery_observed / matching state                 |
| restart nonterminal     | missing/uncertain          | recovery_blocked terminal                          |
| terminal                | late command/callback      | no change; exact replay only                       |

Terminal CAS first wins a cancel CAS; cancellation CAS first blocks new start but
permits the later true terminal. Direct accepted cancellation cannot reopen.
Before create commit no attempt exists. Accepted-before-start is resumable or
cancellable. Spawn before coordinate, or terminal observed before commit, is
recovery_blocked unless safe reconciliation proves state; crash after terminal
commit before notification replays Snapshot. Phase 1 has no lease: a CAS loser
reloads/stops and never repeats a provider effect.
