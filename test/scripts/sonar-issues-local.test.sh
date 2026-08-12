#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="$ROOT_DIR/test/fixtures/sonar"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

cat >"$TEST_DIR/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$SONAR_CURL_ARGS_FILE"
cat "$SONAR_RESPONSE_FIXTURE"
EOF
chmod +x "$TEST_DIR/curl"

run_fixture() {
  local fixture="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  PATH="$TEST_DIR:$PATH" \
    SONAR_ENV_FILE="$TEST_DIR/missing.env" \
    SONAR_PR_KEY=35 \
    SONAR_CURL_ARGS_FILE="$TEST_DIR/curl.args" \
    SONAR_RESPONSE_FIXTURE="$FIXTURE_DIR/$fixture" \
    bash "$ROOT_DIR/scripts/sonar-issues-local.sh" >"$stdout_file" 2>"$stderr_file"
}

run_fixture issues-closed-fixed.json "$TEST_DIR/closed.out" "$TEST_DIR/closed.err"
grep -Fxq 'Sonar open issues: 0' "$TEST_DIR/closed.out"
[[ ! -s "$TEST_DIR/closed.err" ]]
grep -Fxq 'issueStatuses=OPEN,CONFIRMED' "$TEST_DIR/curl.args"

if run_fixture issues-open-confirmed.json "$TEST_DIR/open.out" "$TEST_DIR/open.err"; then
  echo 'Sonar issue inspection accepted unresolved issues.' >&2
  exit 1
fi
grep -Fxq 'Sonar open issues: 2' "$TEST_DIR/open.err"
grep -Fq 'src/open.ts:10 typescript:S0001 MAJOR: Open issue' "$TEST_DIR/open.err"
grep -Fq 'src/confirmed.ts:20 typescript:S0002 CRITICAL: Confirmed issue' "$TEST_DIR/open.err"

for invalid_fixture in \
  issues-malformed.json \
  issues-truncated-resolved-page.json \
  issues-unknown-status.json; do
  if run_fixture "$invalid_fixture" "$TEST_DIR/invalid.out" "$TEST_DIR/invalid.err"; then
    echo "Sonar issue inspection accepted $invalid_fixture." >&2
    exit 1
  fi
done
