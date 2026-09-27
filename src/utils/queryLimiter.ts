/**
 * Runs at most `max` WhatsApp queries at once; the rest wait their turn, in order.
 * One per instance: a burst of events must not become a burst of IQs.
 *
 * Bulk queries (a history batch's pictures) never take the last slot, so a
 * query for a live event waits for at most one query ahead of it, not for the
 * whole bulk backlog. Waiting live queries start before waiting bulk ones.
 */
export class QueryLimiter {
  private inFlight = 0;
  private bulkInFlight = 0;
  private readonly waitingLive: (() => void)[] = [];
  private readonly waitingBulk: (() => void)[] = [];

  constructor(private readonly max: number) {}

  public async run<T>(query: () => Promise<T>, opts: { bulk?: boolean } = {}): Promise<T> {
    const bulk = !!opts.bulk;
    if (this.canStart(bulk)) {
      this.take(bulk);
    } else {
      // The slot is taken for us by the query that finishes, so it is ours when we wake.
      await new Promise<void>((resolve) => (bulk ? this.waitingBulk : this.waitingLive).push(resolve));
    }
    try {
      return await query();
    } finally {
      this.inFlight--;
      if (bulk) this.bulkInFlight--;
      this.wake();
    }
  }

  private canStart(bulk: boolean) {
    return this.inFlight < this.max && (!bulk || this.bulkInFlight < this.max - 1);
  }

  private take(bulk: boolean) {
    this.inFlight++;
    if (bulk) this.bulkInFlight++;
  }

  private wake() {
    while (this.waitingLive.length && this.canStart(false)) {
      this.take(false);
      this.waitingLive.shift()();
    }
    while (this.waitingBulk.length && this.canStart(true)) {
      this.take(true);
      this.waitingBulk.shift()();
    }
  }
}
