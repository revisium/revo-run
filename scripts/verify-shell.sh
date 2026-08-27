#!/usr/bin/env bash
set -euo pipefail

legacy_symbols='ExecutionPlan|RunExecutor|startRun|PipelineInterpreter|NodeEffect|UnknownOutcomeResolution|effect-recovery'

if rg --line-number --ignore-case --glob '!docs/adr/superseded/**' --glob '!scripts/verify-shell.sh' "$legacy_symbols" \
  src test docs README.md REPOSITORY.md REVIEW.md VERIFICATION.md scripts examples; then
  printf '%s\n' 'Legacy plan/executor symbols remain in the active RN1 surface.' >&2
  exit 1
fi

# Fault injection is test-process behaviour, never a shipped runtime backdoor.
# Check both source and built package contents after `pnpm build`.
test_hook_markers='Symbol\.for\(|globalThis\[|test[-_ ]?(fault|hook|marker)'
if rg --line-number --ignore-case "$test_hook_markers" src dist; then
  printf '%s\n' 'Production source or packed output still contains a test hook or marker.' >&2
  exit 1
fi

workflow_probe_markers='WorkflowProbe|reachWorkflowProbe|\.probe(?:\?\.)?\.reach'
if rg --line-number "$workflow_probe_markers" src dist; then
  printf '%s\n' 'Production source or packed output still contains a workflow probe.' >&2
  exit 1
fi

if rg --line-number "from ['\"](?:.*(?:^|/)test/|.*test/support/)" src; then
  printf '%s\n' 'Production source imports test-only code.' >&2
  exit 1
fi
