import {
  OUTBOX_LEASE_MS,
  type ChannelOutbox,
  type DrainResult,
} from "./outbox.ts";

/**
 * Slice (c) part 3a, item 2 — the owner of the drain loop.
 *
 * `ChannelOutbox` is a state machine without a scheduler: `drain()` claims due
 * rows and settles them, and until now nothing called it. This class is the only
 * place that decides WHEN, so the queue has one heartbeat per process instead of
 * one per caller.
 *
 * Facts a caller may rely on:
 *
 * - **Restart survival.** The first tick after `start()` runs against whatever is
 *   in `channel_outbox`, including rows an earlier process left `in_flight`:
 *   `claim()`'s candidate set already covers an expired lease, so a message the
 *   Manager died mid-send comes back. A row whose transport id was written before
 *   the death is *confirmed*, not re-sent — the at-least-once tradeoff of
 *   `outbox.ts`, unchanged here.
 * - **One drain at a time.** Ticks are chained on a single promise, so an
 *   overlapping interval tick cannot race a slow send. The lease is still what
 *   resolves a crashed process, not this chaining.
 * - **SIGTERM semantics.** `stop()` clears the timer (no new claims) and gives
 *   the in-flight tick `graceMs` to settle itself. If it does not, the row stays
 *   `in_flight` **on purpose**: faking a requeue here would let a second process
 *   send a message that the first one already put on the wire. The next start
 *   reclaims it when the lease expires, and `CHANNEL_OUTBOX_IN_FLIGHT_LEFT` is
 *   the log line that says how much work was left to that path.
 *
 * The interval is a wall-clock concern only; every delay decision (backoff,
 * lease, `not_before`) belongs to `outbox.ts` and its injected clock.
 */

/** Default cadence of the loop — 15 s, the same order as the agenda tick. */
export const OUTBOX_DRAIN_INTERVAL_MS = 15_000;

/** How long `stop()` waits for a send in flight before leaving it to the lease. */
export const OUTBOX_STOP_GRACE_MS = 5_000;

export interface OutboxWorkerDeps {
  outbox: ChannelOutbox;
  /** Tick cadence once started. */
  intervalMs?: number;
  /** Rows per tick; absent keeps the outbox default. */
  batch?: number;
  /** Lease window, reported in the reclaim log (the outbox owns the decision). */
  leaseMs?: number;
  /** Grace of `stop()` when the caller does not override it. */
  stopGraceMs?: number;
  log?: (line: string) => void;
}

export interface OutboxStopOptions {
  /** Overrides the configured grace; `0` returns without waiting at all. */
  graceMs?: number;
}

export class ChannelOutboxWorker {
  // Explicit fields, no constructor parameter properties: `node --test` strips
  // types without transpiling and rejects the shorthand.
  private readonly outbox: ChannelOutbox;
  private readonly intervalMs: number;
  private readonly batch: number | undefined;
  private readonly leaseMs: number;
  private readonly stopGraceMs: number;
  private readonly log: (line: string) => void;

  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Never-rejecting chain: the tail `idle()`/`stop()` wait on. */
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: OutboxWorkerDeps) {
    this.outbox = deps.outbox;
    this.intervalMs = deps.intervalMs ?? OUTBOX_DRAIN_INTERVAL_MS;
    this.batch = deps.batch;
    this.leaseMs = deps.leaseMs ?? OUTBOX_LEASE_MS;
    this.stopGraceMs = deps.stopGraceMs ?? OUTBOX_STOP_GRACE_MS;
    this.log = deps.log ?? ((line) => console.error(`[channels] ${line}`));
  }

  /** The loop is claiming rows again after the first `tick()` settles. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Starts the loop: an immediate tick (that is the startup sweep of expired
   * leases) and then the interval. The timer is `unref`'d — a pending drain must
   * never hold the process open on its own.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.kick();
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops claiming and waits up to `graceMs` for the tick that is already
   * running. Rows still `in_flight` afterwards are left as they are (see the
   * class docstring) and reported.
   */
  async stop(options: OutboxStopOptions = {}): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    const grace = options.graceMs ?? this.stopGraceMs;
    if (grace > 0) {
      // Timer NO `unref`: `stop()` se llama desde el apagado, y esperar la gracia
      // máxima es exactamente el contrato. Sin él, un envío que no resuelve
      // vaciaría el event loop y el proceso se iría fuera del margen.
      const settled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), grace);
        void this.tail.then(
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          () => {
            clearTimeout(timer);
            resolve(true);
          },
        );
      });
      if (!settled) {
        this.log(
          `CHANNEL_OUTBOX_STOP_GRACE_EXCEEDED graceMs=${grace}: el envío en vuelo sigue su camino`,
        );
      }
    }

    const counts = await this.outbox.counts().catch(() => undefined);
    if (counts && counts.in_flight > 0) {
      this.log(
        `CHANNEL_OUTBOX_IN_FLIGHT_LEFT=${counts.in_flight} leaseMs=${this.leaseMs}: ` +
          "la siguiente arrancada los reclamará al vencer el lease",
      );
    }
  }

  /**
   * One drain, queued behind whatever is already running. Public and awaited by
   * the tests (and by any caller that wants backpressure) — `start()` is just the
   * timer that calls this.
   */
  tick(): Promise<DrainResult> {
    const work = this.tail.then(async () => {
      // The reclaim notice goes out BEFORE draining: an `in_flight` row is a fact
      // about a previous process, and it is exactly what the lease sweep may take.
      const before = await this.outbox.counts().catch(() => undefined);
      if (before && before.in_flight > 0) {
        this.log(
          `CHANNEL_OUTBOX_RECLAIM in_flight=${before.in_flight} leaseMs=${this.leaseMs}`,
        );
      }
      return this.outbox.drain(this.batch === undefined ? {} : { limit: this.batch });
    });
    this.tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /** Resolves when every tick issued so far has settled (test seam, no sleeps). */
  idle(): Promise<void> {
    return this.tail;
  }

  private kick(): void {
    if (!this.running) return;
    void this.tick().catch((error: unknown) => {
      // A drain must not reject into a timer callback: the worker reports and the
      // next tick tries again; the row state is what actually carries the truth.
      this.log(`CHANNEL_OUTBOX_TICK_FAILED: ${String(error)}`);
    });
  }
}
