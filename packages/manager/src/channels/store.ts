import { promises as fs } from "node:fs";
import path from "node:path";
import { agentPaths, dataPaths } from "@pihub/shared";
import { isChannelKind, type ChannelKind } from "@pihub/channels";

/**
 * Persisted channel state per Agent — the observed surface the Dashboard reads
 * back through `GET /agents/:name/channels`.
 *
 * Deliberately NOT in `agent.json`: that file is what the Runner is spawned
 * with, and the whole point of the ChannelAdapter seam is that a bot token
 * never becomes Agent config. Nothing here can carry a plaintext token — the
 * type has no such field, and `writeChannelRecords` re-checks the keys at run
 * time so a future edit that adds one fails loudly instead of leaking.
 */
export type ChannelObservedStatus = "unpaired" | "pending" | "active" | "error";

export interface ChannelRecord {
  kind: ChannelKind;
  label?: string;
  /** sha256 of the vault ciphertext (or of the token when only a token arrived). */
  tokenDigest?: string;
  /**
   * End of the Dashboard's auto-pair window, verbatim from the projection.
   * `null`/ausente = ventana CERRADA (tombstone H4). Part 1 only STORES it:
   * auto-pair is the consumer (slice (c) part 2), and it is deliberately not
   * re-derived here — pihub never invents a window the owner did not send.
   */
  pairingWindowEndsAt?: string | null;
  observedStatus: ChannelObservedStatus;
  lastError?: string;
  lastSeenAt?: number;
  updatedAt: number;
}

/** Key names that must never reach this file, whatever the caller sends. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "token",
  "telegramToken",
  "plaintextToken",
  "secret",
  "apiKey",
]);

function channelsFile(dataDir: string, agentName: string): string {
  return path.join(agentPaths(dataDir, agentName).root, "channels.json");
}

function assertSecretFree(value: unknown, trail: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${trail}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) {
      throw new Error(`channel state must not persist a secret field: ${trail}${key}`);
    }
    assertSecretFree(nested, `${trail}${key}.`);
  }
}

/**
 * Reads and re-projects the file key by key: a record that grew a field the
 * type does not know about (e.g. a hand-edited `token`) cannot ride into an
 * API response.
 */
export async function readChannelRecords(
  dataDir: string,
  agentName: string,
): Promise<ChannelRecord[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await fs.readFile(channelsFile(dataDir, agentName), "utf8"),
    );
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const records: ChannelRecord[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (!isChannelKind(candidate.kind)) continue;
    const record: ChannelRecord = {
      kind: candidate.kind,
      observedStatus: isObservedStatus(candidate.observedStatus)
        ? candidate.observedStatus
        : "unpaired",
      updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
    };
    if (typeof candidate.label === "string") record.label = candidate.label;
    if (typeof candidate.tokenDigest === "string") {
      record.tokenDigest = candidate.tokenDigest;
    }
    if (
      typeof candidate.pairingWindowEndsAt === "string" ||
      candidate.pairingWindowEndsAt === null
    ) {
      record.pairingWindowEndsAt = candidate.pairingWindowEndsAt;
    }
    if (typeof candidate.lastError === "string") record.lastError = candidate.lastError;
    if (typeof candidate.lastSeenAt === "number") record.lastSeenAt = candidate.lastSeenAt;
    records.push(record);
  }
  return records.sort((a, b) => a.kind.localeCompare(b.kind));
}

function isObservedStatus(value: unknown): value is ChannelObservedStatus {
  return (
    value === "unpaired" ||
    value === "pending" ||
    value === "active" ||
    value === "error"
  );
}

/** Atomic replace (tmp + rename): a crash never leaves half a channel file. */
export async function writeChannelRecords(
  dataDir: string,
  agentName: string,
  records: readonly ChannelRecord[],
): Promise<void> {
  assertSecretFree(records, "");
  const serialized = JSON.stringify(records, null, 2);

  const file = channelsFile(dataDir, agentName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${serialized}\n`, "utf8");
  await fs.rename(tmp, file);
}

/**
 * H5-partial (review round 2): los tokens son memory-only (I1) y los adapters
 * arrancan oscuros tras un restart del Manager hasta que el dashboard
 * re-proyecta. El estado observado viejo (`active`, `lastSeenAt` del proceso
 * anterior) viola I3 — "observed MUST be observed" — así que se resetea al
 * arrancar. Lo deseado (kind/label/tokenDigest/pairingWindowEndsAt) sobrevive.
 * Devuelve los nombres de Agent cuyos archivos tocó.
 */
export async function resetObservedState(dataDir: string): Promise<string[]> {
  const touched: string[] = [];
  // Itera el filesystem (channels.json es la fuente de verdad del reset), no
  // el registro de Agents: un channels.json huérfano también merece reset.
  let entries: string[];
  try {
    entries = await fs.readdir(dataPaths(dataDir).agentsDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const records = await readChannelRecords(dataDir, entry);
    if (records.length === 0) continue;
    let changed = false;
    const reset = records.map((record) => {
      if (
        record.observedStatus === "unpaired" &&
        record.lastError === undefined &&
        record.lastSeenAt === undefined
      ) {
        return record;
      }
      changed = true;
      return {
        ...record,
        observedStatus: "unpaired" as const,
        lastError: undefined,
        lastSeenAt: undefined,
      };
    });
    if (changed) {
      await writeChannelRecords(dataDir, entry, reset);
      touched.push(entry);
    }
  }
  return touched;
}
