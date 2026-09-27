/**
 * Runs at most `max` WhatsApp queries at once; the rest wait their turn, in order.
 * One per instance: a burst of events must not become a burst of IQs.
 */
export class QueryLimiter {
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  public async run<T>(query: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.max) {
      // The slot is handed over by the query that finishes, so it is ours when we wake.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.inFlight++;
    }
    try {
      return await query();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.inFlight--;
    }
  }
}
