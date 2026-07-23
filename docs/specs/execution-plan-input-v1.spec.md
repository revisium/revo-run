# Execution Plan Input v1

- Status: Draft
- Implementation: none
- Public export: none

## Purpose

Define the lifecycle command seam for a host-owned immutable `ExecutionPlan`.
The host compiles, stores, loads, and verifies the plan, then supplies it and its
`CompiledPipeline` with every lifecycle command. `revo-run` verifies the
identity/revision/digest against pins stored on `Run`; it does **not** snapshot
or persist the full plan.

`revo-run` never resolves profiles, models, prompts, permissions, agents,
scripts, executors, credentials, or workspaces.

## Target command input

The final lifecycle input is expected to provide:

- opaque plan id, immutable revision, and digest;
- a verified immutable public `CompiledPipeline`;
- bounded transition policy data needed for the current decision;
- the lifecycle command and its expected run/node/Attempt preconditions.

Executor bindings remain host-owned and are not copied into run state. The input
contains no callbacks, database clients, provider SDK objects, environment
access, mutable containers, or live services.

## Invariants

- `Run` persists only the exact plan identity/revision/digest pins.
- Every lifecycle command supplies a plan matching those pins before any
  pipeline decision or state mutation.
- A missing or mismatched plan fails closed without state/output/event changes.
- The full plan is never stored in `runs`, node instances, outputs, or events.
- Logical node and edge keys are unique and deterministic.
- Every activation key can be derived deterministically from plan location and
  runtime branch/iteration coordinates.
- Referenced successor and join nodes exist.
- Retry and timing limits are finite, bounded, and internally coherent.
- Host-side plan mutation produces a different digest and cannot alter an
  existing run.

## Relationship to revo-pipeline

Only lifecycle imports the public `CompiledPipeline`, `PipelineFacts`, and
`PipelineDecision` contracts owned by `@revisium/revo-pipeline`. Domain first
validates command preconditions and computes a package-owned prospective
state/output change without commit. Lifecycle combines authoritative sibling
state with that prospective outcome/answer into facts, calls the decision API,
and maps the result to package-owned successor/join/wait intents. Domain then
validates the combined intent/invariants before storage CAS and atomic commit.
Pipeline types never enter spec or domain.

This document describes an external seam, not a proposed `spec`-layer type.
Exact lifecycle names, bounds, and digest verification contract remain open
until the Draft is stabilized.
