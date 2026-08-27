export type SonarIssue = Record<string, unknown>;

export declare const actionableSonarIssues: (payload: unknown) => SonarIssue[];
