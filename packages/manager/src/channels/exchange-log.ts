import type { SqliteDb } from "../storage/sqlite.ts";

/**
 * Exchange log (design §1.2/§1.4, slice (c) part 2b) — the projection-in mirror
 * the Dashboard drains.
 *
 * WHY THIS TABLE EXISTS: non-web exchanges are produced inside pihub (the
 * Manager runs those turns) and there is no P→D trust direction — every call is
 * D→P. So P persists the exchange and D pulls it with
 * `GET /agents/:name/channel-exchanges?after=<seq>`, appending it to the
 * authoritative web transcript with its `origin`. The Manager never pushes to
 * the Dashboard, and it never claims to own the transcript: `channel_exchanges`
 * is an append-only feed of facts that already happened.
 *
 * `human` origin is not representable here (the v4 CHECK says so, not a
 * convention): a web turn is written by D itself. Mirroring it would give one
 * fact two writers.
 *
 * The row key is `turn_id`, and it is UNIQUE because the delivery hook that
 * appends here is at-least-once — the same tradeoff the outbox documents
 * (`send` succeeded, SQLite write failed ⇒ retry). `append` therefore returns
 * the row it found when the turn was already logged, instead of throwing or
 * duplicating: a replay must be boring.
 *
 * `id` (INTEGER AUTOINCREMENT) IS the feed cursor D stores as
 * `channels.transcriptSeq`: monotonic per Agent, never reused, and `listAfter`
 * is exclusive so a drained row is never drained twice.
 */

/** Retention window of the mirror (design §2.2/§6.2 — the invariant is "bounded"). */
export const EXCHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows per `GET …/channel-exchanges` call when the caller asks for no limit. */
export const EXCHANGE_FEED_DEFAULT_LIMIT = 100;

/** Hard cap: the caller cannot turn one request into a full table dump. */
export const EXCHANGE_FEED_MAX_LIMIT = 500;

/** `telegram` = reply to a channel-origin turn; `proactive` = agenda Initiative. */
export type ChannelExchangeOrigin = "telegram" | "proactive";

export interface ChannelExchange {
  seq: number;
  agentName: string;
  turnId: string;
  origin: ChannelExchangeOrigin;
  /** Bound external chat id; `null` for a proactive message with no chat context. */
  chatId: string | null;
  userText: string;
  replyText: string;
  createdAt: number;
}

export interface AppendExchangeInput {
  agentName: string;
  turnId: string;
  origin: ChannelExchangeOrigin;
  chatId?: string | null;
  userText: string;
  replyText: string;
  now: number;
}

interface RawExchange {
  id: number;
  agent_name: string;
  turn_id: string;
  origin: string;
  chat_id: string | null;
  user_text: string;
  reply_text: string;
  created_at: number;
}

const SQL_APPEND = `
  INSERT OR IGNORE INTO channel_exchanges
    (agent_name, turn_id, origin, chat_id, user_text, reply_text, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

const SQL_BY_TURN = "SELECT * FROM channel_exchanges WHERE turn_id = ?";

const SQL_AFTER = `
  SELECT * FROM channel_exchanges
  WHERE agent_name = ? AND id > ?
  ORDER BY id ASC
  LIMIT ?
`;

const SQL_LATEST = "SELECT COALESCE(MAX(id), 0) AS seq FROM channel_exchanges WHERE agent_name = ?";

const SQL_PRUNE = "DELETE FROM channel_exchanges WHERE created_at < ?";

function toExchange(raw: RawExchange): ChannelExchange {
  return {
    seq: raw.id,
    agentName: raw.agent_name,
    turnId: raw.turn_id,
    origin: raw.origin as ChannelExchangeOrigin,
    chatId: raw.chat_id,
    userText: raw.user_text,
    replyText: raw.reply_text,
    createdAt: raw.created_at,
  };
}

export class ChannelExchangeLog {
  // Explicit field, not a constructor parameter property: `node --test` runs
  // this file through strip-only TypeScript, which rejects the shorthand.
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  /**
   * Appends one exchange, idempotently by `turn_id`. Returns the row that backs
   * the turn — the freshly inserted one, or the original when a replay got here
   * first (whose text wins because it is what D already drained).
   */
  append(input: AppendExchangeInput): ChannelExchange {
    if (!input.agentName) throw new RangeError("exchange needs an agent_name");
    if (!input.turnId) throw new RangeError("exchange needs a turn_id");
    if (input.origin !== "telegram" && input.origin !== "proactive") {
      // `human` would be the second writer of a fact the Dashboard owns; the
      // CHECK constraint is the backstop, this is the readable one.
      throw new RangeError(`exchange origin is not mirrorable: ${String(input.origin)}`);
    }

    this.db
      .prepare(SQL_APPEND)
      .run(
        input.agentName,
        input.turnId,
        input.origin,
        input.chatId ?? null,
        input.userText,
        input.replyText,
        input.now,
      );

    const raw = this.db.prepare(SQL_BY_TURN).get(input.turnId) as RawExchange | undefined;
    if (!raw) throw new Error(`exchange log lost row for turn ${input.turnId}`);
    return toExchange(raw);
  }

  /** Feed cursor for one Agent: everything up to and including this seq is drained. */
  latestSeq(agentName: string): number {
    const row = this.db.prepare(SQL_LATEST).get(agentName) as { seq: number } | undefined;
    return Number(row?.seq ?? 0);
  }

  /** Rows of one Agent with `seq > after`, oldest first, bounded by `limit`. */
  listAfter(
    agentName: string,
    after: number,
    limit: number = EXCHANGE_FEED_DEFAULT_LIMIT,
  ): ChannelExchange[] {
    const size = Math.min(
      Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : EXCHANGE_FEED_DEFAULT_LIMIT),
      EXCHANGE_FEED_MAX_LIMIT,
    );
    const rows = this.db
      .prepare(SQL_AFTER)
      .all(agentName, Math.max(0, Math.trunc(after) || 0), size) as RawExchange[];
    return rows.map(toExchange);
  }

  /** Drops rows outside the retention window; returns how many went away. */
  prune(now: number): number {
    const result = this.db.prepare(SQL_PRUNE).run(now - EXCHANGE_RETENTION_MS);
    return Number(result.changes);
  }
}
