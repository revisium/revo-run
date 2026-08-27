const actionableStatuses = new Set(['OPEN', 'CONFIRMED']);
const knownStatuses = new Set([
  ...actionableStatuses,
  'FALSE_POSITIVE',
  'ACCEPTED',
  'FIXED',
  'CLOSED',
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} payload @returns {Record<string, unknown>[]} */
export const actionableSonarIssues = (payload) => {
  if (!isRecord(payload) || !Array.isArray(payload.issues)) {
    throw new TypeError('Sonar issue response is missing an issue list.');
  }
  /** @type {Record<string, unknown>[]} */
  const actionable = [];
  for (const issue of payload.issues) {
    if (!isRecord(issue)) {
      throw new TypeError('Sonar issue response contains an invalid issue.');
    }
    const status = Object.hasOwn(issue, 'issueStatus') ? issue.issueStatus : issue.status;
    if (typeof status !== 'string' || !knownStatuses.has(status)) {
      throw new TypeError('Sonar issue response contains an unknown issue status.');
    }
    if (actionableStatuses.has(status)) {
      actionable.push(issue);
    }
  }
  return actionable;
};
