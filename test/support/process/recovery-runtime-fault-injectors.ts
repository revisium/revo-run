import { RunCoordinatorClient } from '../../../src/dbos/coordination/run-coordinator-client.js';
import {
  DbosRunEventStream,
  RunEventBudgetExceededError,
} from '../../../src/dbos/streams/run-event-stream.js';

type Report = (message: object) => void;

export class RecoveryRuntimeFaultInjectors {
  constructor(private readonly report: Report) {}

  failCommandEventBudget(): void {
    const candidate: unknown = Object.getOwnPropertyDescriptor(
      DbosRunEventStream.prototype,
      'append',
    )?.value;
    if (typeof candidate !== 'function') {
      throw new Error('Run event append method is unavailable.');
    }
    DbosRunEventStream.prototype.append = function (event) {
      if (event.type === 'runCommand.accepted' || event.type === 'runCommand.rejected') {
        throw new RunEventBudgetExceededError('maximum_run_event_bytes_exceeded');
      }
      const result: unknown = Reflect.apply(candidate, this, [event]);
      if (!(result instanceof Promise)) {
        throw new Error('Run event append did not return a promise.');
      }
      return result;
    };
  }

  pauseAfterDelayCancelledEvent(): void {
    const candidate: unknown = Object.getOwnPropertyDescriptor(
      DbosRunEventStream.prototype,
      'append',
    )?.value;
    if (typeof candidate !== 'function') {
      throw new Error('Run event append method is unavailable.');
    }
    let paused = false;
    const report = this.report;
    DbosRunEventStream.prototype.append = async function (event) {
      const result: unknown = Reflect.apply(candidate, this, [event]);
      if (!(result instanceof Promise)) {
        throw new Error('Run event append did not return a promise.');
      }
      await result;
      if (!paused && event.type === 'delay.cancelled') {
        paused = true;
        report({ kind: 'afterDelayCancelledEvent' });
        await new Promise(() => undefined);
      }
    };
  }

  pauseAfterInlineOwnership(): void {
    const candidate: unknown = Object.getOwnPropertyDescriptor(
      RunCoordinatorClient.prototype,
      'registerInlineScopeOwnership',
    )?.value;
    if (typeof candidate !== 'function') {
      throw new Error('Inline ownership registration method is unavailable.');
    }
    let paused = false;
    const report = this.report;
    RunCoordinatorClient.prototype.registerInlineScopeOwnership = async function (registration) {
      const result: unknown = Reflect.apply(candidate, this, [registration]);
      if (!(result instanceof Promise)) {
        throw new Error('Inline ownership registration did not return a promise.');
      }
      await result;
      if (!paused) {
        paused = true;
        report({ kind: 'afterInlineOwnership' });
        await new Promise(() => undefined);
      }
    };
  }
}
