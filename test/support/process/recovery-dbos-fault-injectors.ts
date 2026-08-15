import { DBOS, type StepConfig } from '@dbos-inc/dbos-sdk';

import { scopeDirectiveTopic, scopeReplyTopic } from '../../../src/dbos/dbos-names.js';

type Report = (message: object) => void;

export class RecoveryDbosFaultInjectors {
  private releaseAdmissionCallback: (() => void) | undefined;
  private releaseDecisionCallback: (() => void) | undefined;
  private releaseReadinessCallback: (() => void) | undefined;

  constructor(private readonly report: Report) {}

  pauseBeforeFirstIntent(): void {
    const runStep = DBOS.runStep.bind(DBOS);
    let paused = false;
    Object.defineProperty(DBOS, 'runStep', {
      configurable: true,
      value: async <Result>(
        callback: () => Promise<Result>,
        config?: StepConfig & { readonly name?: string },
      ): Promise<Result> => {
        if (!paused && config?.name?.startsWith('node-effect-intent:') === true) {
          paused = true;
          this.report({ kind: 'beforeIntent' });
          return new Promise(() => undefined);
        }
        return runStep(callback, config);
      },
    });
  }

  pauseAfterFirstParallelDecision(): void {
    const runStep = DBOS.runStep.bind(DBOS);
    let paused = false;
    Object.defineProperty(DBOS, 'runStep', {
      configurable: true,
      value: async <Result>(
        callback: () => Promise<Result>,
        config?: StepConfig & { readonly name?: string },
      ): Promise<Result> => {
        const result = await runStep(callback, config);
        if (!paused && config?.name?.startsWith('parallel-join-decision:') === true) {
          paused = true;
          this.report({ kind: 'afterDecision' });
          await new Promise<void>((resolve) => {
            this.releaseDecisionCallback = resolve;
          });
        }
        return result;
      },
    });
  }

  pauseAfterFirstMapDecision(): void {
    const runStep = DBOS.runStep.bind(DBOS);
    let paused = false;
    Object.defineProperty(DBOS, 'runStep', {
      configurable: true,
      value: async <Result>(
        callback: () => Promise<Result>,
        config?: StepConfig & { readonly name?: string },
      ): Promise<Result> => {
        const result = await runStep(callback, config);
        if (!paused && config?.name?.startsWith('map-control-decision:') === true) {
          paused = true;
          this.report({ kind: 'afterDecision' });
          await new Promise<void>((resolve) => {
            this.releaseDecisionCallback = resolve;
          });
        }
        return result;
      },
    });
  }

  pauseAfterTerminalBranchResult(): void {
    const waitFirst = DBOS.waitFirst.bind(DBOS);
    let paused = false;
    Object.defineProperty(DBOS, 'waitFirst', {
      configurable: true,
      value: async (...args: Parameters<typeof DBOS.waitFirst>) => {
        const handle = await waitFirst(...args);
        if (!paused) {
          paused = true;
          this.report({ kind: 'afterTerminalBranchResult' });
          await new Promise(() => undefined);
        }
        return handle;
      },
    });
  }

  pauseBeforeScopeAdmission(targetOrdinal: number): void {
    const sendMessage = DBOS.send.bind(DBOS);
    let admissionOrdinal = 0;
    Object.defineProperty(DBOS, 'send', {
      configurable: true,
      value: async (workflowId: string, message: unknown, topic?: string): Promise<void> => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'scopeAdmission'
        ) {
          admissionOrdinal += 1;
          if (admissionOrdinal === targetOrdinal) {
            this.report({ kind: 'beforeAdmission' });
            await new Promise<void>((resolve) => {
              this.releaseAdmissionCallback = resolve;
            });
          }
        }
        return sendMessage(workflowId, message, topic);
      },
    });
  }

  pauseBeforeScopeReadiness(targetOrdinal: number): void {
    const sendMessage = DBOS.send.bind(DBOS);
    let readinessOrdinal = 0;
    Object.defineProperty(DBOS, 'send', {
      configurable: true,
      value: async (workflowId: string, message: unknown, topic?: string): Promise<void> => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'scopeReady'
        ) {
          readinessOrdinal += 1;
          if (readinessOrdinal === targetOrdinal) {
            this.report({ kind: 'beforeReadiness' });
            await new Promise<void>((resolve) => {
              this.releaseReadinessCallback = resolve;
            });
          }
        }
        return sendMessage(workflowId, message, topic);
      },
    });
  }

  pauseAfterAcceptedCommand(): void {
    const runStep = DBOS.runStep.bind(DBOS);
    let paused = false;
    Object.defineProperty(DBOS, 'runStep', {
      configurable: true,
      value: async <Result>(
        callback: () => Promise<Result>,
        config?: StepConfig & { readonly name?: string },
      ): Promise<Result> => {
        const result = await runStep(callback, config);
        if (
          !paused &&
          config?.name?.startsWith('run-command-decision:') === true &&
          typeof result === 'object' &&
          result !== null &&
          'decision' in result &&
          result.decision === 'accepted'
        ) {
          paused = true;
          this.report({ kind: 'afterAcceptedCommand' });
          await new Promise(() => undefined);
        }
        return result;
      },
    });
  }

  pauseAfterCancelDirective(): void {
    const sendMessage = DBOS.send.bind(DBOS);
    let paused = false;
    Object.defineProperty(DBOS, 'send', {
      configurable: true,
      value: async (workflowId: string, message: unknown, topic?: string): Promise<void> => {
        await sendMessage(workflowId, message, topic);
        if (
          !paused &&
          topic === scopeDirectiveTopic &&
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'cancel'
        ) {
          paused = true;
          this.report({ kind: 'afterCancelDirective' });
          await new Promise(() => undefined);
        }
      },
    });
  }

  reportDelayWait(): void {
    const receive = DBOS.recv.bind(DBOS);
    let reported = false;
    Object.defineProperty(DBOS, 'recv', {
      configurable: true,
      value: async (topic: string, options?: { readonly timeoutSeconds?: number }) => {
        if (!reported && topic === scopeDirectiveTopic && options?.timeoutSeconds === 5) {
          reported = true;
          this.report({ kind: 'delayWaiting' });
        }
        return receive(topic, options);
      },
    });
  }

  reportScopeCancellationAcknowledgement(): void {
    const sendMessage = DBOS.send.bind(DBOS);
    const receive = DBOS.recv.bind(DBOS);
    let awaitingAcknowledgement = false;
    Object.defineProperty(DBOS, 'send', {
      configurable: true,
      value: async (workflowId: string, message: unknown, topic?: string): Promise<void> => {
        await sendMessage(workflowId, message, topic);
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'scopeCancellation'
        ) {
          awaitingAcknowledgement = true;
        }
      },
    });
    Object.defineProperty(DBOS, 'recv', {
      configurable: true,
      value: async (topic: string, options?: { readonly timeoutSeconds?: number }) => {
        const result = await receive(topic, options);
        if (awaitingAcknowledgement && topic === scopeReplyTopic && result !== null) {
          awaitingAcknowledgement = false;
          this.report({ kind: 'scopeCancellationAcknowledged' });
        }
        return result;
      },
    });
  }

  releaseAdmission(): void {
    this.releaseAdmissionCallback?.();
    this.releaseAdmissionCallback = undefined;
  }

  releaseDecision(): void {
    this.releaseDecisionCallback?.();
    this.releaseDecisionCallback = undefined;
  }

  releaseReadiness(): void {
    this.releaseReadinessCallback?.();
    this.releaseReadinessCallback = undefined;
  }
}
