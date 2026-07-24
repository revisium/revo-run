# Documentation

## Current architecture

- [Architecture](architecture.md)
- [Accepted RunManager boundary ADR](adr/0002-run-manager-boundary.md)
- [Superseded run-state boundary ADR](adr/0001-run-state-boundary.md)
- [Consumer example](examples/consumer.md)
- [Testing](testing.md)
- [Release train](release-train.md)

## Draft target specifications

- [Execution plan input v1](specs/execution-plan-input-v1.spec.md)
- [Run domain v1](specs/run-domain-v1.spec.md)
- [Run transitions v1](specs/run-transitions-v1.spec.md)
- [Run storage v1](specs/run-storage-v1.spec.md)
- [RunManager v1](specs/run-manager-v1.spec.md)
- [Run executor v1](specs/run-executor-v1.spec.md)
- [Internal module structure](specs/internal-module-structure.spec.md)

Every product specification above is **Draft** and describes no shipped export.
The architecture rules are Accepted and already enforced by repository
validation.

## Specification conventions

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** are to be interpreted as described in BCP 14
([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and only when, they
appear in all capitals.

The `v1` suffix names a contract family, not a shipped version. Draft contracts
may change before implementation. After a family becomes Stable, incompatible
semantic changes require a new `vN`; compatible clarifications remain in the
same version with an explicit change record.
