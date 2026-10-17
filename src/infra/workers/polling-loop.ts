import type { AppLogger } from "../observability/logger";

/**
 * Loop simples: roda `tick`, espera `intervalMs`, repete. Se o tick disser
 * que ainda tem trabalho (true), roda de novo sem esperar.
 */
export class PollingLoop {
  private running = false;
  private current?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.loop();
    this.logger.info(`${this.name} started`);
  }

  /** Espera o tick atual terminar. Não interrompe trabalho no meio. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
    this.logger.info(`${this.name} stopped`);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let more = false;
      try {
        more = await this.tick();
      } catch (err) {
        this.logger.failure(`${this.name} tick failed`, err);
      }
      if (!more && this.running) await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.intervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
