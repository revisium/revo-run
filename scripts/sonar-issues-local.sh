#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SONAR_ENV_FILE="${SONAR_ENV_FILE:-.env.sonar}"
if [[ -f "$SONAR_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SONAR_ENV_FILE"
  set +a
fi

SONAR_HOST_URL="${SONAR_HOST_URL:-https://sonarcloud.io}"
if [[ -z "${SONAR_TOKEN:-}" ]]; then
  echo "SONAR_TOKEN is required to inspect Sonar issues; an unavailable provider cannot pass." >&2
  exit 1
fi

PROJECT_KEY="$(sed -n 's/^sonar.projectKey=//p' sonar-project.properties | head -n 1)"
if [[ -z "$PROJECT_KEY" ]]; then
  echo "sonar.projectKey was not found in sonar-project.properties." >&2
  exit 1
fi

SONAR_EXPECTED_REVISION="${SONAR_EXPECTED_REVISION:-$(git rev-parse HEAD)}"
scope_args=()
scope_kind="branch"
scope_value=""

if [[ -n "${SONAR_PR_KEY:-}" ]]; then
  scope_kind="pullRequest"
  scope_value="${SONAR_PR_KEY}"
elif [[ "${GITHUB_EVENT_NAME:-}" == pull_request* && -f "${GITHUB_EVENT_PATH:-}" ]]; then
  pr_number="$(node -e "const fs = require('node:fs'); console.log(JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request.number)")"
  scope_kind="pullRequest"
  scope_value="${pr_number}"
elif [[ -n "${SONAR_BRANCH_NAME:-}" ]]; then
  scope_value="${SONAR_BRANCH_NAME}"
elif command -v gh >/dev/null 2>&1 && pr_json="$(gh pr view --json number 2>/dev/null)"; then
  pr_number="$(node -e "console.log(JSON.parse(process.argv[1]).number)" "$pr_json")"
  scope_kind="pullRequest"
  scope_value="${pr_number}"
else
  scope_value="$(git rev-parse --abbrev-ref HEAD)"
fi
scope_args+=(--data-urlencode "${scope_kind}=${scope_value}")

if [[ "$scope_kind" == "pullRequest" ]]; then
  analysis_query_args=(
    --get "${SONAR_HOST_URL}/api/project_pull_requests/list"
    --data-urlencode "project=${PROJECT_KEY}"
  )
else
  analysis_query_args=(
    --get "${SONAR_HOST_URL}/api/project_analyses/search"
    --data-urlencode "project=${PROJECT_KEY}"
    --data-urlencode "ps=1"
    "${scope_args[@]}"
  )
fi
if ! analysis_response="$(curl -fsS -u "${SONAR_TOKEN}:" "${analysis_query_args[@]}")"; then
  echo "Authenticated Sonar analysis query failed; provider status is unavailable." >&2
  exit 1
fi

if [[ "$scope_kind" == "pullRequest" ]]; then
  if ! node -e '
const payload = JSON.parse(process.argv[1]);
const key = process.argv[2];
const expected = process.argv[3];
const pullRequest = payload.pullRequests?.find((entry) => String(entry.key) === key);
if (!pullRequest) {
  console.error(`Sonar pull request ${key} analysis was not found.`);
  process.exit(1);
}
const actual = pullRequest.commit?.sha;
if (actual !== expected) {
  console.error(`Sonar analysis revision mismatch: expected ${expected}, received ${actual ?? "none"}.`);
  process.exit(1);
}
console.log(`Sonar analysis revision: ${actual}`);
' "$analysis_response" "$scope_value" "$SONAR_EXPECTED_REVISION"; then
    exit 1
  fi
elif ! node -e '
const payload = JSON.parse(process.argv[1]);
const actual = payload.analyses?.[0]?.revision;
const expected = process.argv[2];
if (actual !== expected) {
  console.error(`Sonar analysis revision mismatch: expected ${expected}, received ${actual ?? "none"}.`);
  process.exit(1);
}
console.log(`Sonar analysis revision: ${actual}`);
' "$analysis_response" "$SONAR_EXPECTED_REVISION"; then
  exit 1
fi

issue_query_args=(
  --get "${SONAR_HOST_URL}/api/issues/search"
  --data-urlencode "componentKeys=${PROJECT_KEY}"
  --data-urlencode "issueStatuses=OPEN,CONFIRMED"
  --data-urlencode "ps=500"
  "${scope_args[@]}"
)
if ! response="$(curl -fsS -u "${SONAR_TOKEN}:" "${issue_query_args[@]}")"; then
  echo "Authenticated Sonar issue query failed; provider status is unavailable." >&2
  exit 1
fi

node --input-type=module -e '
import { actionableSonarIssues } from "./scripts/sonar-issue-status.mjs";
const payload = JSON.parse(process.argv[1]);
const issues = actionableSonarIssues(payload);
if (issues.length === 0) {
  console.log("Sonar open issues: 0");
  process.exit(0);
}
console.error(`Sonar open issues: ${issues.length}`);
for (const issue of issues.slice(0, 50)) {
  const component = String(issue.component ?? "").replace(/^[^:]+:/, "");
  const line = issue.line ? `:${issue.line}` : "";
  console.error(`- ${component}${line} ${issue.rule} ${issue.severity}: ${issue.message}`);
}
process.exit(1);
' "$response"
