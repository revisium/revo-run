# Testing

The foundation proves package and architecture integrity before runtime behavior
exists.

## Current lanes

| Lane         | Proof                                                                 |
| ------------ | --------------------------------------------------------------------- |
| Unit         | structural architecture validator and every exact rule                |
| Package      | empty API, package identity, export map, no production dependencies   |
| Architecture | real graph, synthetic target graph, negative probes, cleanup          |
| Coverage     | v8 coverage over production source and architecture validator tooling |
| Packed       | build, declarations/maps, publint, ATTW, isolated ESM/TS/deep imports |

The packed verifier creates exactly one tarball, then uses that same artifact
for ATTW, content validation, extraction, runtime loading, strict TypeScript
resolution, and runtime/type deep-import denial.

## Future behavioral lanes

Domain unit tests will own transition tables and deterministic calculations.
Contract tests will exercise lifecycle commands against a transactional store
fake. PostgreSQL E2E tests will own concurrency properties that a fake cannot
prove: atomic Attempt creation/active-pointer claims, authoritative fences,
retry races, aggregate-revision join liveness, join uniqueness, gate CAS, and
atomic state/output/event commits.

Do not add empty test lanes or `passWithNoTests`. Add a lane when its first
owned behavior exists.

## Test design

- One test file owns one behavioral axis.
- Expected state is written independently of actual state.
- Time, ids, revisions, and fences are deterministic test inputs.
- Concurrency tests use barriers, not arbitrary sleeps.
- Public behavior tests import declared package entrypoints. Future internal
  tests use only the root or curated layer barrels, never private source leaves.
- Private structural tests may import repository tooling directly.
- Fixtures must not hide the transition preconditions being tested.

Run the complete contract in [VERIFICATION.md](../VERIFICATION.md).
