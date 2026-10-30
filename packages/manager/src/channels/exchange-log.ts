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
 *
 * `session_key` (schema v7, T5b/2) is the identity of the turn that produced the
 * exchange. It is written from `CompletedTurn.sessionKey` — the key the turn was
 * actually dispatched with — and it is NULL for every row that predates v7 (the
 * additive migration does not backfill). A reader must treat NULL as «unknown»:
 * guessing `agent:<name>:main` would attribute an old exchange to a session
 * nothing can prove it ran in.
 */

/** Retention window of the mirror (design §2.2/§6.2 — the invariant is "bounded"). */
export const EXCHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows per `GET …/channel-exchanges` call when the caller asks for no limit. */
export const EXCHANGE_FEED_DEFAULT_LIMIT = 100;

/** Hard cap: the caller cannot turn one request into a full table dump. */
export const EXCHANGE_FEED_MAX_LIMIT = 500;

/** `telegram` = reply to a channel-origin turn; `proactive` = agenda Initiative. */
export type ChannelExchangeOrigin = "telegram" | "proactive";

/**
 * Hard guard of ONE full half (T5a, S5).
 *
 * What the guard is, precisely — because the difference matters to the Dashboard:
 *
 * - It is a **documented HARD MAX**, not a preview. A half of up to 32,768
 *   characters is mirrored *verbatim*; that is what `hasFull: true` promises, and
 *   the cap is part of the contract (published in `docs/agent-sessions.md`), not a
 *   silent degradation.
 * - The historical columns `user_text`/`reply_text` keep EXACTLY today's semantics
 *   (the complete halves, unbounded). This migration adds a durable, bounded mirror
 *   and its honest signal; it does not redefine what was already written, and it
 *   does not rewrite a single legacy row.
 * - 32,768 is chosen as the boundary of what one exchange row can carry through
 *   `GET …/channel-exchanges` without letting a single turn inflate a page: the feed
 *   is bounded per call (`EXCHANGE_FEED_MAX_LIMIT`), and a half must not be able to
 *   undo that on its own.
 */
export const CHANNEL_FULL_TEXT_MAX_CHARS = 32_768;

export interface ChannelExchange {
  seq: number;
  agentName: string;
  turnId: string;
  origin: ChannelExchangeOrigin;
      /** Bound external chat id; `null` for a proactive message with no chat context. */
      chatId: string | null;
      /**
       * Key of the session the turn actually ran in (schema v7). `null` for every row
       * that predates v7 (no backfill) and for a delivery with no turn behind it: the
       * feed never fabricates an identity.
       */
      sessionKey: string | null;
  /** Complete human half as the mirror always stored it (v4 semantics, untouched). */
  userText: string;
  /** Complete Agent half as the mirror always stored it (v4 semantics, untouched). */
  replyText: string;
  /**
   * Durable full human half (schema v6). `null` for every row that predates v6:
   * the migration does not backfill, so a legacy row is preview-only and says so.
   */
  userFullText: string | null;
  /** Durable full Agent half (schema v6); `null` for rows that predate v6. */
  replyFullText: string | null;
  /**
   * `true` only when this row carries the durable full transcript — both halves
   * present (an EMPTY half is a real half: a proactive turn has no human text but
   * still has its reply). `false` is the honest answer for legacy rows, and readers
   * must fall back to the preview columns instead of inventing text.
   */
  hasFull: boolean;
  createdAt: number;
}

    export interface AppendExchangeInput {
      agentName: string;
      turnId: string;
      origin: ChannelExchangeOrigin;
      chatId?: string | null;
      /**
       * Identidad del turno (`CompletedTurn.sessionKey`). Opcional para no romper los
       * callers que no tienen un turno detrás; ausente = `null` honesto, nunca la
       * sesión seleccionada ahora.
       */
      sessionKey?: string | null;
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
  session_key: string | null;
  user_text: string;
  reply_text: string;
  user_full_text: string | null;
  reply_full_text: string | null;
  created_at: number;
}

const SQL_APPEND = `
  INSERT OR IGNORE INTO channel_exchanges
    (agent_name, turn_id, origin, chat_id, session_key, user_text, reply_text,
     user_full_text, reply_full_text, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    
/** Agent purge (revocation 3c): the mirror of a deleted Agent has no owner left. */
const SQL_DELETE_FOR_AGENT = "DELETE FROM channel_exchanges WHERE agent_name = ?";

/**
 * Bounds ONE full half at the documented hard max. Slicing (never redaction, never
 * summarisation) keeps the prefix of what the user actually wrote, so a truncated
 * half is still truthful about its content up to the cap.
 */
function boundedHalf(text: string): string {
  return text.length > CHANNEL_FULL_TEXT_MAX_CHARS
    ? text.slice(0, CHANNEL_FULL_TEXT_MAX_CHARS)
    : text;
}

function toExchange(raw: RawExchange): ChannelExchange {
  const userFullText = raw.user_full_text ?? null;
  const replyFullText = raw.reply_full_text ?? null;
  return {
    seq: raw.id,
    agentName: raw.agent_name,
    turnId: raw.turn_id,
    origin: raw.origin as ChannelExchangeOrigin,
    chatId: raw.chat_id,
    sessionKey: raw.session_key ?? null,
    userText: raw.user_text,
    replyText: raw.reply_text,
    userFullText,
    replyFullText,
    // Both halves or nothing: a row half-full of full text would be a shape the
    // Dashboard cannot present honestly, and the writer never produces one.
    hasFull: userFullText !== null && replyFullText !== null,
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
   *
   * A NEW row always carries the durable full transcript (v6): both halves go into
   * `user_full_text`/`reply_full_text` bounded by `CHANNEL_FULL_TEXT_MAX_CHARS`, so
   * `hasFull` is `true`. The historical columns are written with the same text they
   * always were (complete, unbounded) — this method changed WHERE the durable signal
   * lives, not what an exchange means.
   *
   * T5b/2: a new row also carries `session_key`, the identity of the turn (`null`
   * when the caller has none). Its column is nullable and additive precisely
   * because the past cannot be attributed retroactively.
   *
   * A ROW THAT ALREADY EXISTS is never touched: `INSERT OR IGNORE` keeps the legacy
   * row exactly as the user decided it must stay (READ-ONLY honest history), which is
   * why its full columns remain NULL for ever instead of being backfilled on retry.
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
        input.sessionKey ?? null,
        input.userText,
        input.replyText,
        boundedHalf(input.userText),
        boundedHalf(input.replyText),
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
    
      /**
       * Drops EVERY mirror row of one Agent and returns how many went away (spec
       * `agent-channels` → Revocation semantics (c), Agent deletion).
       *
       * `prune()` cannot do this job: it is age-based, so the exchanges of a purged
       * Agent would sit in the database for 30 days — and `channel_exchanges` is
       * keyed by `agent_name`, so an Agent re-created with the same name would find
       * somebody else's history behind its own cursor. The agent DIRECTORY is what
       * `deleteAgent()` removes; this table lives in the Manager database, which is
       * why the purge route has to say it out loud.
       */
      deleteForAgent(agentName: string): number {
        const result = this.db.prepare(SQL_DELETE_FOR_AGENT).run(agentName);
        return Number(result.changes);
      }
}
