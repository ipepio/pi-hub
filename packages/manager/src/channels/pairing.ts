import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentPaths } from "@pihub/shared";
import type { ChannelKind } from "@pihub/channels";
import { readChannelRecords, type ChannelRecord } from "./store.ts";

/**
 * Manager-owned pairing machine (design §2.1, `agent-channels` spec).
 *
 * WHY THE MANAGER OWNS IT: it is the only party that ever sees an inbound
 * message (the Runner's grammy bot is retired), so binding a chat to a channel
 * is a Manager fact. The Dashboard mirrors what it reports — it never invents a
 * state and never derives its own window.
 *
 * Rules this module implements, exactly as the spec freezes them:
 *  1. **Auto-pair** is allowed ONLY while the *projected* window is open
 *     (`pairingWindowEndsAt` in the channel record, ISO 8601) AND the channel
 *     has no binding yet. `null`/absent = window CLOSED (the Dashboard's H4
 *     tombstone), and a window in the past is closed too. The Manager NEVER
 *     computes a window from token-activation time itself.
 *  2. **No stealing**: a channel already bound to chat A refuses chat B
 *     (`CHANNEL_ALREADY_BOUND`). Rebinding only happens through `unbind`, and
 *     re-pairing the SAME chat is idempotent.
 *  3. **Post-window = approval flow**: an unknown chat gets a pairing code, and
 *     the code is the only way in. Codes are 8 chars from an unambiguous base32
 *     alphabet, `sha256`-hashed at rest (the plaintext crosses the caller's
 *     return value only), single use, TTL 1 h, verified with a timing-safe
 *     compare, and at most `MAX_PENDING_PAIRINGS` (3) per channel — the 4th
 *     request is refused with `CHANNEL_PAIRING_LIMIT`.
 *  4. **Unbind does not re-arm auto-pair** (resolution 2): `unbind` remembers
 *     the window value that was open at unbind time (`unboundWindowEndsAt`), so
 *     the same window can never bind again. Only a NEW window — projected by a
 *     fresh token activation — re-arms it. A CLOSED window keeps the approval
 *     flow, which is exactly what the tombstone means.
 *
 * What is deliberately NOT here: inbound handling (`onInbound` → turns), the
 * exchange log and the observed `channels[]` projection are slice (c) part 2b.
 * `requestPairing` is the seam they call; `stateOf` is what they project.
 *
 * Persistence: `channel-pairing.json` next to `channels.json` — separate on
 * purpose. `channels.json` is the observed projection the Dashboard reads;
 * this file is the Manager's private machine state and carries hashes that must
 * never be echoed. It is atomic (tmp + rename) and a secret-key guard runs on
 * every write.
 */

/** Time-to-live of an issued pairing code (spec: 1 hour). */
export const PAIRING_CODE_TTL_MS = 3_600_000;

/** Spec cap: a 4th concurrent request is refused, no code is generated. */
export const MAX_PENDING_PAIRINGS = 3;

/**
 * Unambiguous base32 alphabet: no `I`/`L`/`1`, no `O`/`0`, no `2`-vs-`Z` lookalikes
 * beyond what a chat client cannot fix. 31 symbols, so `randomBytes` mod 31 is
 * uniform enough for a 40-bit code that also expires and is single use.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;

/** Closed catalogue of what the machine throws; routes map it to HTTP as-is. */
export type PairingErrorCode =
  | "CHANNEL_NOT_FOUND"
  | "CHANNEL_ALREADY_BOUND"
  | "CHANNEL_PAIRING_LIMIT"
  | "CHANNEL_PAIRING_CODE_INVALID";

export class PairingError extends Error {
  readonly code: PairingErrorCode;

  constructor(code: PairingErrorCode, message: string) {
    super(message);
    this.name = "PairingError";
    this.code = code;
  }
}

/** Binding lifecycle of one channel. Orthogonal to `observedStatus` (I3). */
export type PairingStateName = "unpaired" | "pending" | "active";

/**
 * One outstanding code. `externalChatId` is who asked; the code is only ever a
 * capability to bind THAT chat, never a bearer token.
 */
export interface PendingPairing {
  externalChatId: string;
  /** sha256 of the code, hex. The plaintext is never stored. */
  codeHash: string;
  requestedAt: number;
  expiresAt: number;
}

export interface ChannelPairing {
  kind: ChannelKind;
  state: PairingStateName;
  externalChatId: string | null;
  pairedAt: number | null;
  pending: PendingPairing[];
  /**
   * Window value consumed by a manual unbind: while the projected window still
   * equals this value, auto-pair stays disarmed (spec "unbind does not re-arm").
   */
  unboundWindowEndsAt: string | null;
  updatedAt: number;
}

export interface PairingRequestResult {
  pairing: ChannelPairing;
  /** Plaintext code, ONLY on a fresh issuance inside a CLOSED window. */
  code?: string;
  /** True when this very call bound the chat through the open window. */
  autoPaired: boolean;
}

export interface PairingMachineDeps {
  dataDir: string;
  now?: () => number;
  /** Test seam for code generation; production uses `randomBytes`. */
  newCode?: () => string;
}

/** Keys that must never appear in the pairing file, whatever a future edit sends. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "token",
  "telegramToken",
  "code",
  "pairingCode",
  "plaintextCode",
  "secret",
  "apiKey",
]);

function assertSecretFree(value: unknown, trail: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${trail}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) {
      throw new Error(`pairing state must not persist a secret field: ${trail}${key}`);
    }
    assertSecretFree(nested, `${trail}${key}.`);
  }
}

function pairingFile(dataDir: string, agentName: string): string {
  return path.join(agentPaths(dataDir, agentName).root, "channel-pairing.json");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Default code source: 8 chars from `CODE_ALPHABET`, uniform per character. */
export function generatePairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

/**
 * Is the auto-pair window open? `null`/absent/garbage/past = CLOSED. The value
 * always comes from the Dashboard projection — the Manager never derives it.
 */
export function windowIsOpen(
  pairingWindowEndsAt: string | null | undefined,
  now: number,
): boolean {
  if (typeof pairingWindowEndsAt !== "string") return false;
  const endsAt = Date.parse(pairingWindowEndsAt);
  return Number.isFinite(endsAt) && endsAt > now;
}

/** Timing-safe compare of two equal-length hex digests. */
function hashesMatch(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(candidate, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function emptyPairing(kind: ChannelKind, now: number): ChannelPairing {
  return {
    kind,
    state: "unpaired",
    externalChatId: null,
    pairedAt: null,
    pending: [],
    unboundWindowEndsAt: null,
    updatedAt: now,
  };
}

/** Re-projects one persisted entry key by key: unknown fields cannot ride along. */
function revivePairing(value: unknown, now: number): ChannelPairing | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const kind = entry.kind;
  if (kind !== "telegram") return undefined;
  const state = entry.state;
  if (state !== "unpaired" && state !== "pending" && state !== "active") return undefined;
  const pending: PendingPairing[] = [];
  if (Array.isArray(entry.pending)) {
    for (const raw of entry.pending) {
      if (typeof raw !== "object" || raw === null) continue;
      const row = raw as Record<string, unknown>;
      if (
        typeof row.externalChatId !== "string" ||
        typeof row.codeHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.codeHash) ||
        typeof row.requestedAt !== "number" ||
        typeof row.expiresAt !== "number"
      ) {
        continue;
      }
      // Read-side sweep: an expired code verifies against nothing.
      if (row.expiresAt <= now) continue;
      pending.push({
        externalChatId: row.externalChatId,
        codeHash: row.codeHash,
        requestedAt: row.requestedAt,
        expiresAt: row.expiresAt,
      });
    }
  }
  const revived: ChannelPairing = {
    kind,
    state,
    externalChatId: typeof entry.externalChatId === "string" ? entry.externalChatId : null,
    pairedAt: typeof entry.pairedAt === "number" ? entry.pairedAt : null,
    pending,
    unboundWindowEndsAt:
      typeof entry.unboundWindowEndsAt === "string" || entry.unboundWindowEndsAt === null
        ? (entry.unboundWindowEndsAt as string | null)
        : null,
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
  };
  // Fail closed on a self-inconsistent read: a state that claims a binding it
  // does not have is repaired, never trusted.
  if (revived.externalChatId === null && revived.state === "active") {
    revived.state = revived.pending.length > 0 ? "pending" : "unpaired";
    revived.pairedAt = null;
  }
  if (revived.pending.length === 0 && revived.state === "pending" && revived.externalChatId === null) {
    revived.state = "unpaired";
  }
  return revived;
}

export class PairingMachine {
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly newCode: () => string;
  /**
   * Serializes read-modify-write per Agent: two chats asking at the same time
   * must not both count against `MAX_PENDING_PAIRINGS`.
   */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(deps: PairingMachineDeps) {
    this.dataDir = deps.dataDir;
    this.now = deps.now ?? (() => Date.now());
    this.newCode = deps.newCode ?? generatePairingCode;
  }

  /** Current pairing state of one channel, or `undefined` when it has none. */
  async stateOf(agentName: string, kind: ChannelKind): Promise<ChannelPairing | undefined> {
    return this.load(agentName, kind);
  }

  /**
   * The single entry point for "this chat wants to talk to the Agent": auto-pair
   * inside an open window, code outside it. Part 2b's inbound handler calls this
   * before queuing a turn; the `POST …/pairing` route is its HTTP face.
   */
  async requestPairing(
    agentName: string,
    kind: ChannelKind,
    externalChatId: string,
  ): Promise<PairingRequestResult> {
    return this.serialized(agentName, async () => {
      const record = await this.requireConfigured(agentName, kind);
      const current = (await this.load(agentName, kind)) ?? emptyPairing(kind, this.now());
      const chat = trim(externalChatId);
      if (!chat) throw new PairingError("CHANNEL_PAIRING_CODE_INVALID", "externalChatId is required");

      if (current.externalChatId === chat) {
        // Already bound to this chat: idempotent, no new code, no rebinding.
        return { pairing: current, autoPaired: false };
      }
      if (current.externalChatId !== null) {
        throw new PairingError(
          "CHANNEL_ALREADY_BOUND",
          `channel "${kind}" is already bound to another chat`,
        );
      }

      const windowEndsAt = record.pairingWindowEndsAt ?? null;
      const reArmed =
        current.unboundWindowEndsAt === null || current.unboundWindowEndsAt !== windowEndsAt;
      if (windowIsOpen(windowEndsAt, this.now()) && reArmed) {
        const bound: ChannelPairing = {
          ...current,
          state: "active",
          externalChatId: chat,
          pairedAt: this.now(),
          pending: [],
          updatedAt: this.now(),
        };
        await this.save(agentName, bound);
        return { pairing: bound, autoPaired: true };
      }

      const code = this.newCode();
      const issued: PendingPairing = {
        externalChatId: chat,
        codeHash: hashPairingCode(code),
        requestedAt: this.now(),
        expiresAt: this.now() + PAIRING_CODE_TTL_MS,
      };
      // Same chat asking again simply replaces its own outstanding code; it does
      // not consume one of the three slots.
      const others = current.pending.filter((row) => row.externalChatId !== chat);
      if (others.length >= MAX_PENDING_PAIRINGS) {
        throw new PairingError(
          "CHANNEL_PAIRING_LIMIT",
          `channel "${kind}" already has ${MAX_PENDING_PAIRINGS} pending pairing requests`,
        );
      }
      const next: ChannelPairing = {
        ...current,
        state: "pending",
        pending: [...others, issued],
        updatedAt: this.now(),
      };
      await this.save(agentName, next);
      return { pairing: next, code, autoPaired: false };
    });
  }

  /**
   * Owner (or Dashboard, on the owner's click) redeems a code for the chat it
   * was issued to. Wrong, expired, already-redeemed or foreign-chat code →
   * `CHANNEL_PAIRING_CODE_INVALID`, always through a timing-safe compare.
   */
  async approve(
    agentName: string,
    kind: ChannelKind,
    input: { code: string; externalChatId: string },
  ): Promise<ChannelPairing> {
    return this.serialized(agentName, async () => {
      await this.requireConfigured(agentName, kind);
      const current = (await this.load(agentName, kind)) ?? emptyPairing(kind, this.now());
      const chat = trim(input.externalChatId);
      const candidate = hashPairingCode(input.code ?? "");
      const match = current.pending.find(
        (row) => row.externalChatId === chat && hashesMatch(row.codeHash, candidate),
      );
      if (!match || input.code === undefined || input.code === "") {
        throw new PairingError(
          "CHANNEL_PAIRING_CODE_INVALID",
          "pairing code does not match this request",
        );
      }
      // Single use: the row disappears with the binding.
      const bound: ChannelPairing = {
        ...current,
        state: "active",
        externalChatId: chat,
        pairedAt: this.now(),
        pending: current.pending.filter((row) => row !== match),
        updatedAt: this.now(),
      };
      await this.save(agentName, bound);
      return bound;
    });
  }

  /** Owner refuses one outstanding request. Idempotent; never touches a binding. */
  async reject(agentName: string, kind: ChannelKind, externalChatId: string): Promise<ChannelPairing> {
    return this.serialized(agentName, async () => {
      await this.requireConfigured(agentName, kind);
      const current = (await this.load(agentName, kind)) ?? emptyPairing(kind, this.now());
      const chat = trim(externalChatId);
      const next: ChannelPairing = {
        ...current,
        pending: current.pending.filter((row) => row.externalChatId !== chat),
        updatedAt: this.now(),
      };
      next.state = next.externalChatId !== null ? "active" : next.pending.length > 0 ? "pending" : "unpaired";
      await this.save(agentName, next);
      return next;
    });
  }

  /**
   * "Desvincular": drop the binding and disarm auto-pair FOR THAT WINDOW. The
   * next binding needs the approval flow (spec resolution 2), and only a new
   * projected window — a fresh token activation — re-arms it.
   */
  async unbind(agentName: string, kind: ChannelKind): Promise<ChannelPairing> {
    return this.serialized(agentName, async () => {
      const record = await this.requireConfigured(agentName, kind);
      const current = (await this.load(agentName, kind)) ?? emptyPairing(kind, this.now());
      const next: ChannelPairing = {
        kind,
        state: "unpaired",
        externalChatId: null,
        pairedAt: null,
        pending: [],
        unboundWindowEndsAt: record.pairingWindowEndsAt ?? null,
        updatedAt: this.now(),
      };
      await this.save(agentName, next);
      return next;
    });
  }

  /** Channel removed (`DELETE …/channels/:kind`): the state goes with it. */
  async remove(agentName: string, kind: ChannelKind): Promise<void> {
    await this.serialized(agentName, async () => {
      const all = await this.loadAll(agentName);
      if (!all.has(kind)) return;
      all.delete(kind);
      await this.saveAll(agentName, all);
    });
  }

  /**
   * Replace-all convergence: a kind that disappeared from the projection loses
   * its pairing state too (I2 — `[]` means "nothing", never "keep what you
   * had"). Kinds that stay keep their binding: an idempotent projection must not
   * un-pair a live channel, and a rotated token keeps its chat (state diagram
   * `active --> active`).
   */
  async prune(agentName: string, kinds: readonly ChannelKind[]): Promise<void> {
    await this.serialized(agentName, async () => {
      const keep = new Set(kinds);
      const all = await this.loadAll(agentName);
      let changed = false;
      for (const kind of [...all.keys()]) {
        if (!keep.has(kind)) {
          all.delete(kind);
          changed = true;
        }
      }
      if (changed) await this.saveAll(agentName, all);
    });
  }

  // --- internals -------------------------------------------------------------

  /**
   * Pairing only makes sense on a channel the Manager can actually reach: the
   * record must exist AND carry a credential digest. A projection without a
   * token registers the channel as `unpaired` with no adapter, so there is no
   * bot to bind and no code to answer with.
   */
  private async requireConfigured(
    agentName: string,
    kind: ChannelKind,
  ): Promise<ChannelRecord> {
    const records = await readChannelRecords(this.dataDir, agentName);
    const record = pickRecord(records, kind);
    if (!record) {
      throw new PairingError("CHANNEL_NOT_FOUND", `agent has no "${kind}" channel`);
    }
    if (!record.tokenDigest) {
      throw new PairingError(
        "CHANNEL_NOT_FOUND",
        `channel "${kind}" has no credential configured; it cannot pair`,
      );
    }
    return record;
  }

  private async load(agentName: string, kind: ChannelKind): Promise<ChannelPairing | undefined> {
    return (await this.loadAll(agentName)).get(kind);
  }

  /** Corrupt or missing file fails closed to "no state", never throws. */
  private async loadAll(agentName: string): Promise<Map<ChannelKind, ChannelPairing>> {
    const map = new Map<ChannelKind, ChannelPairing>();
    let raw: unknown;
    try {
      raw = JSON.parse(
        await fs.readFile(pairingFile(this.dataDir, agentName), "utf8"),
      );
    } catch {
      return map;
    }
    if (!Array.isArray(raw)) return map;
    for (const entry of raw) {
      const revived = revivePairing(entry, this.now());
      if (revived) map.set(revived.kind, revived);
    }
    return map;
  }

  private async saveAll(
    agentName: string,
    all: Map<ChannelKind, ChannelPairing>,
  ): Promise<void> {
    const rows = [...all.values()].sort((a, b) => a.kind.localeCompare(b.kind));
    assertSecretFree(rows, "");
    const file = pairingFile(this.dataDir, agentName);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    // Atomic replace: a crash must not leave half a pairing table, which would
    // silently un-bind a live channel.
    await fs.writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  }

  private async save(agentName: string, pairing: ChannelPairing): Promise<void> {
    const all = await this.loadAll(agentName);
    all.set(pairing.kind, pairing);
    await this.saveAll(agentName, all);
  }

  /** One in-flight mutation per Agent; other Agents are never blocked. */
  private async serialized<T>(
    agentName: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.chains.get(agentName) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chains.set(
      agentName,
      previous.then(() => gate.then(() => undefined)),
    );
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function pickRecord(
  records: ChannelRecord[],
  kind: ChannelKind,
): ChannelRecord | undefined {
  return records.find((record) => record.kind === kind);
}

function trim(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Exported for part 2b: the inbound handler resolves the window through this. */
export function pairingWindowOf(
  records: ChannelRecord[],
  kind: ChannelKind,
): string | null {
  return pickRecord(records, kind)?.pairingWindowEndsAt ?? null;
}
