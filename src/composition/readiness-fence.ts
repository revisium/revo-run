export class RunHostReadinessFence {
  private opened = false;
  private resolveOpen: (() => void) | undefined;
  private readonly openPromise = new Promise<void>((resolve) => {
    this.resolveOpen = resolve;
  });

  async awaitOpen(): Promise<void> {
    if (!this.opened) {
      await this.openPromise;
    }
  }

  open(): void {
    if (!this.opened) {
      this.opened = true;
      this.resolveOpen?.();
    }
  }
}
