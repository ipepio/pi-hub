import type { SqliteDb } from "../storage/sqlite.ts";
import { ChannelExchangeLog } from "./exchange-log.ts";
import { ChannelOutbox, type ChannelOutboxOptions } from "./outbox.ts";

/**
 * Slice (c) part 3a, item 1 — the SQLite seam the channel machinery needed.
 *
 * `ChannelOutbox` and `ChannelExchangeLog` both speak SQL, and `ManagerStore`
 * deliberately hides its `SqliteDb` (the driver is an implementation detail of
 * `storage/`, exactly like the Agenda repository wraps it). Without a door,
 * production code could not build either class: the v4 tables existed, were
 * tested at the class level, and had no owner.
 *
 * This facade is that door, and it is narrow on purpose: it hands out the two
 * stores that already know their own SQL, never the driver. A caller cannot run
 * arbitrary statements through it, cannot read another Agent's rows it was not
 * given a store for, and cannot bypass the reservation discipline of the outbox.
 *
 * `createOutbox` is a factory instead of a field because the outbox's `send` is
 * injected — the transport lives on `channels/registry.ts`, which the composition
 * root builds after the store is open. The factory is cheap (no I/O) and every
 * instance shares one driver, so a row enqueued by one is drained by the next.
 */
export interface ChannelPersistence {
  /** Append-only mirror feed the Dashboard drains projection-in (design §1.2). */
  readonly exchanges: ChannelExchangeLog;
  /** The durable queue bound to the same driver as `exchanges`. */
  createOutbox(options: ChannelOutboxOptions): ChannelOutbox;
}

/** Binds the channel stores to an already-migrated Manager database. */
export function openChannelPersistence(db: SqliteDb): ChannelPersistence {
  const exchanges = new ChannelExchangeLog(db);
  return {
    exchanges,
    createOutbox(options: ChannelOutboxOptions): ChannelOutbox {
      return new ChannelOutbox(db, options);
    },
  };
}
