import type { JsonValue } from '../spec/index.js';

export interface RunExecutor {
  execute(request: {
    readonly runId: string;
    readonly nodeKey: string;
    readonly candidate?: string;
    readonly input: JsonValue;
  }): Promise<{ readonly outcome: 'completed' | 'failed'; readonly output?: JsonValue }>;
}
