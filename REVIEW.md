# Review Contract

Reject compatibility code from the removed `0.1.x` runtime, undocumented public exports, and deep
package entrypoints.

DBOS workflow input, step output, workflow result, and streams are the durable execution source.
Reject a second scheduler, progress store, or result store unless a missing DBOS capability is
demonstrated first.

Sequential `await` is intentional in the DBOS state-machine files listed by the exact
`no-await-in-loop` override in `.oxlintrc.json`: call order determines durable function IDs,
admission, and capacity reuse. Do not expand that override to ordinary application or read-model
code without demonstrating the same requirement.

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
be reused as a serialized DTO. The same rule applies to the Date-bearing `RunDetails` projections
(`scopes`, `nodeInstances`, `attempts`, `commands`, `gates`, `consensuses`): they ship no runtime
schema. Durable observation payloads (`parallelJoins`, `skippedParallelBranches`, `mapExecutions`,
`skippedMapItems`) stay TypeBox-first and their schemas are public.

Bounded-concurrency scope fan-out (parallel, map) uses a pure reducer that returns actions, a
DBOS action interpreter, and a scope controller. Coordination registries stay pure in-memory
state; DBOS transport lives in a sibling module.

Name unit tests after the unit under test. The `rrNN-` prefix scheme is retired; fixture
directories keep their milestone names. Public manager inputs that map to an error code without
throwing are `isX`; durable envelopes that throw are `parseX`. `XWorkflowArgumentsParser` is the
DBOS `inputSchema` adapter shape, not a third naming idiom.

`Type.Unsafe` is allowed only for the reviewed recursive seams in
`contracts/json-value.ts` and
`contracts/pipeline/pipeline-node.schema.ts`. Subpipeline recursion is invalid; use bounded `repeat`
for iteration.

## Architectural Consistency

The same responsibility uses one established idiom. A competing pattern for classes, functions,
dependency composition, ports, adapters, validation, mapping, errors, or tests requires an explicit
rationale.

Consistency never justifies needless abstractions whose only purpose is to make different
responsibilities look alike.

## Readability Blocker

Reject a changed function, class, or test when it operates at more than one abstraction level.
Keep these responsibilities distinct: orchestration, domain policy, provider protocol and IO,
validation and mapping, and fixture construction. Each test must have one diagnosable reason to
fail; keep multiple assertions together only when they prove one business outcome.

Extraction must be semantic. Split by a named responsibility, not by line count, and do not move
unrelated behavior into generic helper or utility dumping grounds.

Review every change for the following:

- the unit has one purpose that can be stated in one sentence;
- its statements stay at one abstraction level;
- domain policy is separate from provider protocol and IO;
- validation and mapping do not absorb orchestration;
- fixture construction does not hide the behavior or boundary under test;
- each test failure identifies one behavior outcome;
- every extraction names a real responsibility and does not merely reduce line count.
