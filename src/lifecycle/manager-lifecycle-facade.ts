import type { ManagerRunSnapshot } from './manager-run-snapshot.js';
import type { ManagerStartRunCommand } from './manager-start-run-command.js';

export interface ManagerLifecycleFacade {
  beginStartCycle(): string;
  startRun(command: ManagerStartRunCommand): Promise<ManagerRunSnapshot>;
  getRun(runId: string): Promise<ManagerRunSnapshot | undefined>;
  recover(managerIncarnationId: string, signal: AbortSignal): Promise<void>;
  runOne(
    managerIncarnationId: string,
    signal: AbortSignal,
    mode?: 'normal' | 'recovery',
  ): Promise<void>;
  handoffActive(
    managerIncarnationId: string,
    reason?: 'manager_shutdown' | 'manager_start_failure',
  ): Promise<void>;
}
