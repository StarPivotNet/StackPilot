import { CacheError } from "./errors.js";

export type ProgressDeadlineOptions = { windowMs: number; minBytesPerSecond: number };

/**
 * A transfer is dead when it stops making progress, not when it stops sending bytes: a throttled peer
 * trickles often enough to keep any idle timer armed. So the floor is a rate over a window instead of
 * a gap between chunks. Consumers pass `signal` to their pipeline or destroy their stream on abort.
 * One instance per task: it is not reusable once stopped.
 */
export class ProgressDeadline {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private windowStart: number;
  private bytes = 0;
  private started = false;
  private stopped = false;

  constructor(readonly options: ProgressDeadlineOptions, private readonly now: () => number = Date.now) {
    this.windowStart = now();
    // A quarter window keeps detection inside 1.25 windows without sampling every chunk.
    this.timer = setInterval(() => this.check(), Math.max(50, Math.floor(options.windowMs / 4)));
    this.timer.unref?.();
  }

  get signal() { return this.controller.signal; }

  observe(bytes: number) {
    if (this.stopped) return;
    // The clock starts at the first byte: waiting on a slow origin's headers is not a stalled
    // transfer, and a transfer that never delivers one is bounded by its own timeouts instead.
    if (!this.started) { this.started = true; this.windowStart = this.now(); this.bytes = 0; }
    this.bytes += bytes;
  }

  /** Called once the bytes are all in: a transfer waiting on its digest is not a stalled transfer. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.controller.abort();
  }

  private check() {
    if (this.stopped || !this.started) return;
    const at = this.now();
    const elapsed = at - this.windowStart;
    if (elapsed < this.options.windowMs) return;
    // Judged against the time that actually passed, so a late tick cannot fail a fast transfer.
    const floor = (this.options.minBytesPerSecond * elapsed) / 1000;
    if (this.bytes >= floor) {
      this.windowStart = at;
      this.bytes = 0;
      return;
    }
    const stalled = new CacheError(
      "CACHE_TRANSFER_STALLED",
      `The transfer moved ${this.bytes} bytes in ${Math.round(elapsed / 1000)}s, below ${this.options.minBytesPerSecond} B/s`,
    );
    this.stopped = true;
    clearInterval(this.timer);
    this.controller.abort(stalled);
  }
}
