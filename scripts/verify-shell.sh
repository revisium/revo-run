#!/usr/bin/env bash
set -euo pipefail

# Node is a package runtime requirement, so these scans do not depend on an
# undeclared runner utility. The scanner executes all four required scopes and
# fails after reporting every forbidden match.
node --experimental-strip-types scripts/verify-surface.ts
