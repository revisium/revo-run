export class NodeExecutionBudget {
  private remaining: number;

  constructor(maximumExecutions: number) {
    this.remaining = maximumExecutions;
  }

  reserve(): boolean {
    if (this.remaining === 0) {
      return false;
    }

    this.remaining -= 1;
    return true;
  }
}
