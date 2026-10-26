// channels-and-mcp · slice (c) fix round B · H5-partial
//
// El estado observado de channels.json es del proceso anterior: los tokens son
// memory-only (I1), los adapters arrancan oscuros tras un restart del Manager
// hasta que el dashboard re-proyecta, y un `observedStatus: "active"` con
// `lastSeenAt` viejo viola I3 ("observed MUST be observed"). `resetObservedState`
// limpia esos campos al arrancar.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { resetObservedState, readChannelRecords, writeChannelRecords } from "../dist/channels/store.js";

describe("H5 — resetObservedState", () => {
  const dirs: string[] = [];
  async function tmpDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "pihub-reset-"));
    dirs.push(dir);
    return dir;
  }
  after(() => {
    for (const dir of dirs) void rm(dir, { recursive: true, force: true });
  });

  it("resetea observedStatus/lastError/lastSeenAt de un registro viejo", async () => {
    const dataDir = await tmpDataDir();
    await writeChannelRecords(dataDir, "agent-a", [
      {
        kind: "telegram",
        label: "bot",
        tokenDigest: "a".repeat(64),
        observedStatus: "active",
        lastError: "boom",
        lastSeenAt: 1_000,
        updatedAt: 1_000,
      },
    ]);

    const touched = await resetObservedState(dataDir);

    assert.ok(touched.includes("agent-a"));
    const records = await readChannelRecords(dataDir, "agent-a");
    assert.equal(records[0]?.observedStatus, "unpaired");
    assert.equal(records[0]?.lastError, undefined);
    assert.equal(records[0]?.lastSeenAt, undefined);
    // Lo deseado no se toca: digest y ventana sobreviven.
    assert.equal(records[0]?.tokenDigest, "a".repeat(64));
  });

  it("no reporta ni reescribe Agents sin canales o ya limpios", async () => {
    const dataDir = await tmpDataDir();
    await writeChannelRecords(dataDir, "agent-clean", [
      {
        kind: "telegram",
        observedStatus: "unpaired",
        updatedAt: 1_000,
      },
    ]);

    const touched = await resetObservedState(dataDir);

    assert.deepEqual(touched, []);
    const records = await readChannelRecords(dataDir, "agent-clean");
    assert.equal(records.length, 1);
  });
});
