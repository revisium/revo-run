import type {
  AnswerGateInput,
  CancelRunInput,
  ResolveUnknownOutcomeInput,
  RunCommandReceipt,
} from '../contracts/run/run-command.js';
import { RunManagerError } from '../contracts/run/run-manager-error.js';
import {
  isAnswerGateInput,
  isCancelRunInput,
  isResolveUnknownOutcomeInput,
} from '../validation/run-command.validator.js';

interface RunCommandRuntime {
  cancelRun(input: CancelRunInput): Promise<RunCommandReceipt>;
  resolveUnknownOutcome(input: ResolveUnknownOutcomeInput): Promise<RunCommandReceipt>;
  answerGate(input: AnswerGateInput): Promise<RunCommandReceipt>;
}

export class RunCommandDispatcher {
  private readonly runtime: RunCommandRuntime;

  constructor(runtime: RunCommandRuntime) {
    this.runtime = runtime;
  }

  cancel(input: CancelRunInput): Promise<RunCommandReceipt> {
    if (!isCancelRunInput(input)) {
      throw new RunManagerError('invalid_cancel_run_input');
    }
    return this.dispatch(() => this.runtime.cancelRun(input));
  }

  resolveUnknownOutcome(input: ResolveUnknownOutcomeInput): Promise<RunCommandReceipt> {
    if (!isResolveUnknownOutcomeInput(input)) {
      throw new RunManagerError('invalid_resolve_unknown_outcome_input');
    }
    return this.dispatch(() => this.runtime.resolveUnknownOutcome(input));
  }

  answerGate(input: AnswerGateInput): Promise<RunCommandReceipt> {
    if (!isAnswerGateInput(input)) {
      throw new RunManagerError('invalid_answer_gate_input');
    }
    return this.dispatch(() => this.runtime.answerGate(input));
  }

  private async dispatch(operation: () => Promise<RunCommandReceipt>): Promise<RunCommandReceipt> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_command_failed');
    }
  }
}
