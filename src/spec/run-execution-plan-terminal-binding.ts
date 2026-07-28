export type RunExecutionPlanTerminalBinding =
  | {
      readonly nodeKey: string;
      readonly outcome: string;
      readonly status: 'succeeded' | 'cancelled';
    }
  | {
      readonly nodeKey: string;
      readonly outcome: string;
      readonly status: 'failed';
      readonly fault: {
        readonly code: 'PIPELINE_TERMINAL';
        readonly message: string;
      };
    };
