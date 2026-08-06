# Review Contract

Reject compatibility code from the removed `0.1.x` runtime, undocumented public exports, and deep
package entrypoints.

DBOS workflow input, step output, workflow result, and streams are the durable execution source.
Reject a second scheduler, progress store, or result store unless a missing DBOS capability is
demonstrated first.

Treat an authored TypeScript file above 300 lines as a review signal. Split it by capability or
responsibility unless keeping a cohesive declarative contract together is demonstrably clearer.
Do not satisfy this guidance with arbitrary line-based fragments.

Keep public value contracts under `src/contracts`, the public manager facade under `src/manager`,
deterministic pipeline behavior under `src/pipeline`, DBOS integration under `src/dbos`, and
boundary validation under `src/validation`. Code under `src/pipeline` must depend on ports rather
than DBOS implementations. Durable or externally supplied data must enter through a compiled
schema validator; do not add hand-written recursive shape guards. Schema tests must cover accepted
values, malformed nested values, additional properties, and identifier grammar.

JSON-compatible contract schemas are the source of truth and ordinary durable types must be
derived with `Type.Static`. `RunSnapshot` is an in-memory view containing `Date` values and must not
be reused as a serialized DTO. `Type.Unsafe` is allowed only for the reviewed recursive seams in
`contracts/json-value.ts` and
`contracts/pipeline/pipeline-node.schema.ts`. Subpipeline recursion is invalid; use bounded `repeat`
for iteration.

## Architectural Consistency

The same responsibility uses one established idiom. A competing pattern for classes, functions,
dependency composition, ports, adapters, validation, mapping, errors, or tests requires an explicit
rationale.

Consistency never justifies needless abstractions whose only purpose is to make different
responsibilities look alike.
