import { createHash, randomUUID } from "node:crypto";
import { isChannelKind, type ChannelKind } from "@pihub/channels";
import type { SqliteDb } from "../storage/sqlite.ts";

/**
 * Slice (c) part 2a — the durable outbox (specs `pihub-manager-channels` →
 * “Outbox — SQLite migration v4” + “drain worker”, design §2.2).
 *
 * One row per proactive/agent-originated message to a Channel. The row is
 * simultaneously the queue item and the delivery record, so a Manager restart
 * cannot lose a message that was already accepted, and cannot re-send one that
 * was already confirmed.
 *
 * The state machine (design §2.2) — every edge is a method here and nothing else:
 *
 * ```
 * pending --> in_flight          claim(): fills in_flight_at, leases OUTBOX_LEASE_MS
 * in_flight --> delivered        send() resolved → external_message_id = real id
 * in_flight --> pending          retryable failure → attempts+1, exponential backoff
 * in_flight --> dead             attempts >= MAX_OUTBOX_ATTEMPTS, or terminal transport error
 * pending --> dead               channel teardown (deadFor): NO delivery, no farewell (I2)
 * ```
 *
 * Facts a caller may rely on:
 * - **Reservation.** `id` is `pending:<uuid>` for the row's whole life (the v4
 *   table CHECK-encodes the prefix). `claim()` moves a row to `in_flight` with a
 *   guarded UPDATE, so a second worker — or a second tick of this one — cannot
 *   take the same row while the lease is alive.
 * - **At-least-once with idempotency.** The transport id is written BEFORE the
 *   terminal state. If the confirmation write then fails, the row goes back to
 *   `pending` with its `external_message_id` already set, and the next drain
 *   finalizes it without calling `send()` again. `channel_outbox_external_message`
 *   (unique, partial) is the backstop.
 * - **One retry owner.** The adapter never retries (see `@pihub/channels`
 *   `ChannelAdapter.send`); this class is the only place that decides to try
 *   again, so the backoff and the attempt budget have a single home.
 * - **Teardown is not delivery.** `deadFor()` exists for the `PUT /channels`
 *   replace-all and `DELETE /channels/:kind` paths: rows reach the terminal
 *   `dead` state without a single send.
 *
 * The class is transport-agnostic by construction: `send` is injected, so the
 * Manager never needs a bot token or a grammy type to drain the queue, and tests
 * drive the whole state machine with a closure.
 */

/** Attempt budget: the 8th failure is terminal (`attempts >= MAX_OUTBOX_ATTEMPTS`). */
export const MAX_OUTBOX_ATTEMPTS = 8;

/** How long a claimed row may stay `in_flight` before another worker may take it. */
export const OUTBOX_LEASE_MS = 120_000;

/** First retry delay; each attempt doubles it. */
export const OUTBOX_BACKOFF_BASE_MS = 30_000;

/** Ceiling of the exponential backoff (15 min), so a sick transport is probed slowly. */
export const OUTBOX_BACKOFF_CAP_MS = 900_000;

/**
 * Deterministic jitter, expressed as a fraction of the computed delay, added on
 * top of it (never subtracted). Workers that woke together stop synchronizing on
 * the same tick, while `delay(n+1) > delay(n)` still holds — the growth the
 * tests pin is not a coin flip.
 */
export const OUTBOX_JITTER_RATIO = 0.25;

/** Rows claimed per `drain()` tick when the caller does not say otherwise. */
export const OUTBOX_DEFAULT_BATCH = 25;

/** Upper bound of the persisted `last_error`, so a transport dump cannot bloat the row. */
const LAST_ERROR_LIMIT = 500;

/** Codes that mean “this chat/credential will never work”: die on the first failure. */
const TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_chat",
  "invalid_token",
]);

export type OutboxState = "pending" | "in_flight" | "delivered" | "dead";

export interface OutboxRow {
  /** Reservation id, `pending:<uuid>`; stable across the row's whole life. */
  id: string;
  agentName: string;
  kind: ChannelKind;
  /** External chat id as a string — the wire contract never carries numbers. */
  target: string;
  /** Serialized message envelope (`{"text": "…"}`), exactly as enqueued. */
  payload: string;
  /** Convenience view of `payload.text`, so a `send` closure has the body at hand. */
  text: string;
  state: OutboxState;
  attempts: number;
  /** When a retryable row becomes claimable again; `null` = due now. */
  nextAttemptAt: number | null;
  /** Real transport id once the send succeeded; `null` until then. */
  externalMessageId: string | null;
  /** Claim instant, the lease anchor. */
  inFlightAt: number | null;
  lastError: string | null;
  deliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface OutboxEnqueueInput {
  agentName: string;
  kind: ChannelKind;
  target: string;
  /** Serialized envelope. Kept opaque here: the transport decides what it means. */
  payload: string;
  /** Delay the first attempt (a caller pacing itself); absent = due immediately. */
  notBefore?: number;
}

export interface ChannelOutboxOptions {
  /**
   * Sends one row and resolves with the transport's message id. Rejections are
   * classified by the worker: an error whose `code` is terminal (see
   * `TERMINAL_ERROR_CODES`) kills the row, anything else is retryable.
   */
  send: (row: OutboxRow) => Promise<string>;
  /** Clock for `created_at`/`updated_at`/backoff/lease. Tests inject a manual one. */
  now?: () => number;
  /**
   * Seam that runs AFTER the transport accepted the message and BEFORE the
   * confirmation lands. Production leaves it unset; tests use it to simulate a
   * SQLite failure in that exact window (the at-least-once tradeoff).
   */
  onDelivered?: (row: OutboxRow, externalMessageId: string) => void;
  maxAttempts?: number;
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Rows claimed per drain tick. */
  batch?: number;
  /** Sanitized log line sink; `console.error` in production. */
  log?: (line: string) => void;
}

export interface OutboxClaimOptions {
  /** Ignore `next_attempt_at` and take rows that are not due yet. Test/repair aid. */
  force?: boolean;
}

export interface OutboxDrainOptions extends OutboxClaimOptions {
  limit?: number;
}

export interface DrainResult {
  /** Rows this tick actually handed to the transport. */
  attempted: number;
  /** Rows confirmed `delivered`. */
  delivered: number;
  /** Rows re-queued with backoff (retryable failure). */
  requeued: number;
  /** Rows moved to `dead` by this tick (budget exhausted or terminal error). */
  dead: number;
}

/**
 * Every statement of the worker, static by design: the table ships no dynamic
 * SQL, only parameters. `SELECT_COLUMNS` is written out per query on purpose.
 */
const SQL_INSERT = `
  INSERT INTO channel_outbox (id, agent_name, kind, target, payload, state,
    attempts, next_attempt_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`;

const SQL_BY_ID = `
  SELECT id, agent_name, kind, target, payload, state, attempts, next_attempt_at,
    external_message_id, in_flight_at, last_error, delivered_at, created_at, updated_at
  FROM channel_outbox WHERE id = ?`;

const SQL_PENDING_OF = `
  SELECT id, agent_name, kind, target, payload, state, attempts, next_attempt_at,
    external_message_id, in_flight_at, last_error, delivered_at, created_at, updated_at
  FROM channel_outbox
  WHERE agent_name = ? AND kind = ? AND state = 'pending'
  ORDER BY created_at, id`;

/** Due rows: nobody has them, and the backoff has elapsed. */
const SQL_CANDIDATES_DUE = `
  SELECT id, agent_name, kind, target, payload, state, attempts, next_attempt_at,
    external_message_id, in_flight_at, last_error, delivered_at, created_at, updated_at
  FROM channel_outbox
  WHERE (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
     OR (state = 'in_flight' AND in_flight_at <= ?)
  ORDER BY created_at, id
  LIMIT ?`;

/** Same set without the due filter — the lease half of the predicate stays live. */
const SQL_CANDIDATES_FORCED = `
  SELECT id, agent_name, kind, target, payload, state, attempts, next_attempt_at,
    external_message_id, in_flight_at, last_error, delivered_at, created_at, updated_at
  FROM channel_outbox
  WHERE state = 'pending'
     OR (state = 'in_flight' AND in_flight_at <= ?)
  ORDER BY created_at, id
  LIMIT ?`;

/** The reservation itself: repeat the candidate predicate in WHERE, trust `changes`. */
const SQL_RESERVE = `
  UPDATE channel_outbox
  SET state = 'in_flight', in_flight_at = ?, updated_at = ?
  WHERE id = ?
    AND (state = 'pending' OR (state = 'in_flight' AND in_flight_at <= ?))`;

const SQL_RECORD_EXTERNAL = `
  UPDATE channel_outbox
  SET external_message_id = ?, updated_at = ?
  WHERE id = ? AND external_message_id IS NULL`;

const SQL_MARK_DELIVERED = `
  UPDATE channel_outbox
  SET state = 'delivered', external_message_id = ?, last_error = NULL,
      next_attempt_at = NULL, in_flight_at = NULL, delivered_at = ?, updated_at = ?
  WHERE id = ?`;

const SQL_REQUEUE = `
  UPDATE channel_outbox
  SET state = 'pending', attempts = ?, last_error = ?, next_attempt_at = ?,
      in_flight_at = NULL, updated_at = ?
  WHERE id = ? AND state = 'in_flight'`;

const SQL_KILL = `
  UPDATE channel_outbox
  SET state = 'dead', attempts = ?, last_error = ?, next_attempt_at = NULL,
      in_flight_at = NULL, updated_at = ?
  WHERE id = ? AND state = 'in_flight'`;

const SQL_DEAD_FOR = `
  UPDATE channel_outbox
  SET state = 'dead', last_error = ?, next_attempt_at = NULL, in_flight_at = NULL,
      updated_at = ?
  WHERE agent_name = ? AND kind = ? AND state IN ('pending', 'in_flight')`;

/** Agent purge (revocation 3c): every kind at once, kind-blind by necessity. */
const SQL_DEAD_FOR_AGENT = `
  UPDATE channel_outbox
  SET state = 'dead', last_error = ?, next_attempt_at = NULL, in_flight_at = NULL,
      updated_at = ?
  WHERE agent_name = ? AND state IN ('pending', 'in_flight')`;

const SQL_COUNTS = `SELECT state, COUNT(*) AS total FROM channel_outbox GROUP BY state`;

interface RawRow {
  id: string;
  agent_name: string;
  kind: string;
  target: string;
  payload: string;
  state: string;
  attempts: number;
  next_attempt_at: number | null;
  external_message_id: string | null;
  in_flight_at: number | null;
  last_error: string | null;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

/** The text a transport sends: `payload.text` when the envelope is JSON, else the payload. */
export function outboxTextOf(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object") {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  } catch {
    // Not JSON: the payload IS the text.
  }
  return payload;
}

function toRow(raw: RawRow): OutboxRow {
  return {
    id: raw.id,
    agentName: raw.agent_name,
    kind: isChannelKind(raw.kind) ? raw.kind : (raw.kind as ChannelKind),
    target: raw.target,
    payload: raw.payload,
    text: outboxTextOf(raw.payload),
    state: raw.state as OutboxState,
    attempts: Number(raw.attempts),
    nextAttemptAt: raw.next_attempt_at === null ? null : Number(raw.next_attempt_at),
    externalMessageId: raw.external_message_id,
    inFlightAt: raw.in_flight_at === null ? null : Number(raw.in_flight_at),
    lastError: raw.last_error,
    deliveredAt: raw.delivered_at === null ? null : Number(raw.delivered_at),
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

/** Message an operator can read, with no chance of carrying a transport dump. */
function describeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  return message.slice(0, LAST_ERROR_LIMIT);
}

/**
 * Terminal code of a delivery failure, or `null` when it is retryable. Read
 * structurally instead of by `instanceof`: the adapter class can arrive through
 * `src` or `dist`, and a fake that throws a plain object with the same `code`
 * must be classified identically.
 */
function terminalCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TERMINAL_ERROR_CODES.has(code) ? code : null;
}

/** The `retry_after` a `rate_limited` transport asked for, when it is sane. */
function retryAfterMsOf(error: unknown): number | null {
  const retryAfterMs = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
    ? retryAfterMs
    : null;
}

/**
 * Jitter in `[0, OUTBOX_JITTER_RATIO]`, derived from the row id instead of an RNG:
 * stable for a given row, independent across rows, and reproducible under an
 * injected clock.
 */
// Milliseconds of jitter per row, as integer steps of 1 ms over the ratio above.
const JITTER_STEPS = Math.round(OUTBOX_JITTER_RATIO * 1000) + 1;

function jitterFractionOf(id: string): number {
  const digest = createHash("sha256").update(id).digest();
  return (digest.readUInt32BE(0) % JITTER_STEPS) / 1000;
}

export class ChannelOutbox {
  private readonly db: SqliteDb;
  private readonly send: (row: OutboxRow) => Promise<string>;
  private readonly now: () => number;
  private readonly onDelivered:
    | ((row: OutboxRow, externalMessageId: string) => void)
    | undefined;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly batch: number;
  private readonly log: (line: string) => void;

  constructor(db: SqliteDb, options: ChannelOutboxOptions) {
    this.db = db;
    this.send = options.send;
    this.now = options.now ?? (() => Date.now());
    this.onDelivered = options.onDelivered;
    this.maxAttempts = options.maxAttempts ?? MAX_OUTBOX_ATTEMPTS;
    this.leaseMs = options.leaseMs ?? OUTBOX_LEASE_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? OUTBOX_BACKOFF_BASE_MS;
    this.backoffCapMs = options.backoffCapMs ?? OUTBOX_BACKOFF_CAP_MS;
    this.batch = options.batch ?? OUTBOX_DEFAULT_BATCH;
    this.log = options.log ?? ((line) => console.error(line));
  }

  /**
   * Reserves a row and returns it. This is the only accepted entry point for an
   * outbound message: a caller that wants a Channel delivery enqueues here and
   * never touches the adapter itself, so retry policy keeps one owner.
   */
  async enqueue(input: OutboxEnqueueInput): Promise<OutboxRow> {
    if (!input.agentName) throw new RangeError("outbox row needs an agent_name");
    if (!isChannelKind(input.kind)) {
      throw new RangeError(`unsupported channel kind: ${String(input.kind)}`);
    }
    if (!input.target) throw new RangeError("outbox row needs a target chat id");
    if (typeof input.payload !== "string") {
      throw new RangeError("outbox payload must be serialized before enqueue");
    }

    const id = `pending:${randomUUID()}`;
    const now = this.now();
    this.db
      .prepare(SQL_INSERT)
      .run(
        id,
        input.agentName,
        input.kind,
        input.target,
        input.payload,
        input.notBefore ?? null,
        now,
        now,
      );

    const row = await this.byId(id);
    if (!row) throw new Error(`outbox enqueue did not persist row ${id}`);
    return row;
  }

  async byId(id: string): Promise<OutboxRow | undefined> {
    const raw = this.db.prepare(SQL_BY_ID).get(id) as RawRow | undefined;
    return raw ? toRow(raw) : undefined;
  }

  /** Rows still waiting for a first delivery for one agent + kind. */
  async pendingOf(agentName: string, kind: ChannelKind): Promise<OutboxRow[]> {
    const raws = this.db
      .prepare(SQL_PENDING_OF)
      .all(agentName, kind) as RawRow[];
    return raws.map(toRow);
  }

  /**
   * Takes up to `limit` due rows and reserves them (`pending` → `in_flight`).
   *
   * Two candidate sets, both real: rows nobody has claimed, and `in_flight` rows
   * whose lease expired — the latter is the crash-recovery edge of §2.2, so a
   * Manager that died mid-send re-queues its own work instead of wedging it.
   * The UPDATE repeats the candidate predicate in its WHERE and the row is only
   * handed out when `changes === 1`: the reservation is what keeps a second
   * worker out, not a read-then-write assumption.
   */
  async claim(
    limit = this.batch,
    options: OutboxClaimOptions = {},
  ): Promise<OutboxRow[]> {
    const now = this.now();
    const leaseCutoff = now - this.leaseMs;
    const candidates = (
      options.force
        ? this.db.prepare(SQL_CANDIDATES_FORCED).all(leaseCutoff, limit)
        : this.db.prepare(SQL_CANDIDATES_DUE).all(now, leaseCutoff, limit)
    ) as RawRow[];

    const claimed: OutboxRow[] = [];
    for (const candidate of candidates) {
      const reserved = this.db
        .prepare(SQL_RESERVE)
        .run(now, now, candidate.id, leaseCutoff);
      if (Number(reserved.changes) === 1) {
        const row = await this.byId(candidate.id);
        if (row) claimed.push(row);
      }
    }
    return claimed;
  }

  /**
   * One drain tick: claim, hand each row to the transport, settle the outcome.
   * A failure of one row never aborts the tick — the queue is drained per row and
   * every terminal decision is persisted before the next row is touched.
   */
  async drain(options: OutboxDrainOptions = {}): Promise<DrainResult> {
    const result: DrainResult = {
      attempted: 0,
      delivered: 0,
      requeued: 0,
      dead: 0,
    };
    const rows = await this.claim(options.limit ?? this.batch, {
      force: options.force,
    });

    for (const row of rows) {
      result.attempted += 1;

      // Already sent in a previous life: finalize instead of re-sending. This is
      // the idempotency half of “send OK, SQLite update failed”.
      if (row.externalMessageId !== null) {
        try {
          this.markDelivered(row.id, row.externalMessageId);
          result.delivered += 1;
        } catch (error) {
          this.fail(row, error, result);
        }
        continue;
      }

      let externalMessageId: string;
      try {
        externalMessageId = await this.send(row);
      } catch (error) {
        this.fail(row, error, result);
        continue;
      }
      if (typeof externalMessageId !== "string" || externalMessageId === "") {
        this.fail(row, new Error("channel adapter returned no message id"), result);
        continue;
      }

      try {
        // Write order matters: the transport id lands BEFORE the terminal state.
        this.recordExternalMessageId(row.id, externalMessageId);
        this.onDelivered?.(row, externalMessageId);
        this.markDelivered(row.id, externalMessageId);
        result.delivered += 1;
      } catch (error) {
        // The message is out there but we cannot prove it: at-least-once says the
        // row goes back to `pending` keeping its external id, never to `dead`.
        this.fail(row, error, result);
      }
    }

    return result;
  }

  /**
   * Channel teardown (I2, design §2.1 “silent stop, outbox drained to dead”):
   * rows for one agent + kind reach the terminal state WITHOUT a send. Returns
   * how many rows were moved, so a route can log the effect it had.
   */
      async deadFor(agentName: string, kind: ChannelKind, reason: string): Promise<number> {
        const result = this.db
          .prepare(SQL_DEAD_FOR)
          .run(describeError(reason), this.now(), agentName, kind);
        return Number(result.changes);
      }
    
      /**
       * Agent teardown (spec `agent-channels` → Revocation semantics (c): «The purge
       * path stops the channel adapter … Drains the channel outbox to terminal
       * state»). Same semantics as `deadFor` — `pending`/`in_flight` become `dead`
       * WITHOUT a send, delivered history stays readable — but scoped to the AGENT,
       * which is what a purge needs: by the time the route runs the projection
       * (`channels.json`) is on its way out, so there is no authoritative kind list
       * left to iterate, and a row of a kind nobody projected anymore would survive
       * the purge and be retried through whatever adapter later took that slot.
       */
      async deadForAgent(agentName: string, reason: string): Promise<number> {
        const result = this.db
          .prepare(SQL_DEAD_FOR_AGENT)
          .run(describeError(reason), this.now(), agentName);
        return Number(result.changes);
      }

  /** Rows in the queue per state — the observable count a status surface can show. */
  async counts(): Promise<Record<OutboxState, number>> {
    const raws = this.db.prepare(SQL_COUNTS).all() as Array<{
      state: string;
      total: number;
    }>;
    const counts: Record<OutboxState, number> = {
      pending: 0,
      in_flight: 0,
      delivered: 0,
      dead: 0,
    };
    for (const raw of raws) counts[raw.state as OutboxState] = Number(raw.total);
    return counts;
  }

  /**
   * Delay before attempt number `attempts` (1-based). A transport that said
   * `retry_after` is obeyed first (clamped to the same window we use ourselves);
   * otherwise the exponential ladder, capped, plus additive deterministic jitter.
   */
  private backoffMs(
    attempts: number,
    id: string,
    retryAfterMs: number | null,
  ): number {
    if (retryAfterMs !== null) {
      return Math.min(
        Math.max(retryAfterMs, this.backoffBaseMs),
        this.backoffCapMs,
      );
    }
    const grown =
      this.backoffBaseMs * 2 ** Math.min(Math.max(attempts - 1, 0), 30);
    const capped = Math.min(grown, this.backoffCapMs);
    return Math.round(capped * (1 + jitterFractionOf(id)));
  }

  /** Retryable or terminal? Then persist exactly one of the two outcomes. */
  private fail(row: OutboxRow, error: unknown, result: DrainResult): void {
    const attempts = row.attempts + 1;
    const terminalCode = terminalCodeOf(error);
    const reason = describeError(error);
    const now = this.now();

    if (attempts >= this.maxAttempts || terminalCode !== null) {
      this.db
        .prepare(SQL_KILL)
        .run(attempts, reason, now, row.id);
      result.dead += 1;
      this.log(
        `CHANNEL_OUTBOX_DIED id=${row.id} agent=${row.agentName} kind=${row.kind} attempts=${attempts} reason=${terminalCode ?? "attempts_exhausted"}`,
      );
      return;
    }

    const delayMs = this.backoffMs(attempts, row.id, retryAfterMsOf(error));
    this.db
      .prepare(SQL_REQUEUE)
      .run(attempts, reason, now + delayMs, now, row.id);
    result.requeued += 1;
    this.log(
      `CHANNEL_OUTBOX_RETRY id=${row.id} agent=${row.agentName} kind=${row.kind} attempts=${attempts} delayMs=${delayMs}`,
    );
  }

  /** First write of the confirmation pair: remember what the transport said. */
  private recordExternalMessageId(id: string, externalMessageId: string): void {
    this.db
      .prepare(SQL_RECORD_EXTERNAL)
      .run(externalMessageId, this.now(), id);
  }

  /** Second write of the confirmation pair: the row is terminally delivered. */
  private markDelivered(id: string, externalMessageId: string): void {
    const now = this.now();
    this.db
      .prepare(SQL_MARK_DELIVERED)
      .run(externalMessageId, now, now, id);
  }
}
