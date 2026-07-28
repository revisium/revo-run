# Portable run contracts v1

- Status: Stable
- Version: v1
- Implementation: Implemented

## Normative language and compatibility

BCP 14 keywords are interpreted per RFC 2119/RFC 8174 only when uppercase.
Incompatible changes to this Stable family require a new `vN`. Compatible
clarifications may remain in v1 with an explicit change record.

## Scope

This specification defines the portable immutable values that can ship before
the real pipeline decoder, store, executor adapter, lifecycle, or manager
exists. The package root exports these contracts as TypeScript types only. Its
runtime namespace remains empty.

The package internally implements defensive snapshot and validation helpers for
these values. Those helpers are not public package entrypoints.

## Common input rules

Boundary helpers MUST inspect descriptors before values, MUST NOT invoke
accessors or `toJSON`, and MUST reject unsupported prototypes, symbols, sparse
or modified arrays, cycles, unsupported primitives, non-finite numbers, and
unpaired surrogates.

Accepted collections and payloads MUST be defensively copied and recursively
frozen. JSON values use the Stable canonical JSON v1 limits: maximum depth 64,
65,536 aggregate members, and 1,048,576 canonical UTF-8 bytes.

Portable JSON arrays MUST be ordinary recursively frozen readonly arrays. They
retain standard read operations including iteration, `forEach`, and spread.
The canonicalizer's private hardened array representation MUST NOT cross into a
plan document, executor configuration, or output payload.

Bounded identifier text MUST be non-empty, well-formed Unicode without C0, DEL,
or C1 control characters. Unless a narrower field rule applies, identifiers
MUST contain at most 256 UTF-8 bytes.

## Exact pins

`ExecutionPlanPin` contains exactly:

- `id`;
- `revision`;
- `digest`.

Each field follows the common identifier bound. The plan digest is opaque and
host-owned. `revo-run` MUST compare it exactly and MUST NOT recompute or
reinterpret it with canonical JSON.

`ExecutorContractPin` contains exactly:

- `adapterId`;
- `revision`;
- `digest`.

Each field follows the same bound. Executor resolution MUST eventually use the
complete exact pin; latest, compatible, nearest, and default resolution are not
part of this contract.

## Executor configuration

Executor configuration is a complete bounded `JsonValue` snapshot.
`ExecutorConfigurationDigest` is the Stable canonical JSON SHA-256 digest of
that complete immutable configuration and has the exact
`sha256:<64 lowercase hexadecimal digits>` representation.

The package MUST reject a supplied binding whose configuration digest differs
from the digest it computes with the Stable canonical JSON v1 algorithm.

## Execution plan document

`RunExecutionPlanDocument` contains exactly:

- its exact `pin`;
- `compiledPipeline` as bounded `JsonValue`;
- zero to 4,096 immutable executor bindings.

ADR 0003 accepts a later versioned extension with zero to 4,096 immutable
package-owned terminal bindings. That extension is not part of the currently
implemented Stable snapshot until its source, validation, types, declarations
and packed proof ship together. Each accepted binding maps one exact
`nodeKey`/`outcome` pair to:

- `succeeded` or `cancelled` with no fault; or
- `failed` with exact bounded `PIPELINE_TERMINAL` fault.

The future private seam validates a bijection against decoded compiled
terminals. No pipeline-owned type enters this portable contract.

The whole document also remains inside the common canonical JSON depth, member,
and UTF-8 limits. `compiledPipeline` is not decoded and is not presented as a
pipeline-package type.

Each `RunExecutionPlanExecutorBinding` contains:

- a non-empty `nodeKey` of at most 256 UTF-8 bytes;
- an exact `ExecutorContractPin`;
- complete immutable JSON configuration;
- the exact canonical configuration digest;
- `idempotentExecution`;
- one retry policy;
- one timeout policy.

Node keys MUST be unique within a document. A missing idempotency declaration
normalizes to `false`; the package MUST NOT infer idempotency from any other
field. After all defaults are materialized, the complete normalized document
MUST be revalidated against the shared depth, member, and canonical UTF-8
bounds. This validation MUST NOT recompute the opaque host-owned plan digest.

## Bounded policies

All numeric fields are safe integers.

| Contract                        | Field                                    | Inclusive bounds          |
| ------------------------------- | ---------------------------------------- | ------------------------- |
| `RetryPolicy`                   | `maximumAttempts`                        | 1 to 100                  |
| `RetryPolicy`                   | `initialBackoffMs`                       | 0 to 86,400,000           |
| `RetryPolicy`                   | `maximumBackoffMs`                       | initial to 86,400,000     |
| `RetryPolicy`                   | `backoffMultiplier`                      | 1 to 16                   |
| `TimeoutPolicy`                 | each timeout                             | 1 to 86,400,000 ms        |
| `LeasePolicy`                   | `leaseDurationMs`                        | 1,000 to 86,400,000 ms    |
| `LeasePolicy`                   | `heartbeatIntervalMs`                    | 100 to 86,400,000 ms      |
| `ProcessLocalConcurrencyPolicy` | `maximumConcurrentExecutions`            | 1 to 1,024                |
| `ProcessLocalConcurrencyPolicy` | `maximumConcurrentExecutionsPerExecutor` | 1 to global process limit |

Heartbeat interval MUST be strictly less than lease duration. These policy
values do not authorize durable time decisions; later store/lifecycle behavior
uses database transaction time.

## Output payloads and artifacts

`RunOutputPayload` is a closed union:

- `{ kind: "json", value: JsonValue }`; or
- `{ kind: "artifact", artifact: RunArtifactReference }`.

`RunArtifactReference` contains exactly:

- `artifactId`: 1 to 256 UTF-8 bytes under the common text rules;
- `mediaType`: 3 to 127 printable ASCII token characters in exact
  `type/subtype` form, without parameters;
- `sha256`: exactly 64 lowercase hexadecimal digits;
- `bytes`: a safe integer from zero through `Number.MAX_SAFE_INTEGER`.

It MUST NOT contain a URL, path, locator, provider, retention rule, credential,
or provider-specific metadata.

## Faults and conflicts

`RunFault` and `RunConflict` are stable type-only records containing a closed
code plus a message. Messages MUST be non-empty, well-formed, control-free, and
at most 512 UTF-8 bytes before persistence or publication.

Fault codes distinguish invalid input, not found, invalid state, stale
activation, revision conflict, stale fence, plan unavailable/mismatch,
executor unavailable/mismatch, unknown outcome, and cancellation. Conflict
codes distinguish invalid state, stale activation, revision conflict, stale
fence, and idempotency conflict.

No runtime error class, provider exception, stack trace, or unbounded supplied
data is part of this contract.

## Explicitly deferred

This contract does not implement or promise:

- pipeline JSON decoding or graph progression;
- manager behavior or a public manager facade;
- `createRunManager`;
- provider artifact retrieval;
- agent-runtime or script executors;
- production composition.

The package-private `ExecutionPlanSource` now defines exact loading by the
complete pin into a package-owned immutable document or a closed bounded
not-found/unavailable/mismatch fault. It remains an internal construction
contract until production composition and the public manager facade ship.
