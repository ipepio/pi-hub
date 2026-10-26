import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { loadEnv } from "@pihub/shared";

// Cutover (slice (c) part 3b, proposal R3): the Telegram bot is Manager-owned.
// The Runner keeps only the turn surface (sessions, tools, uploads, WS). These
// tests pin the ABSENCE: they are the regression gate that stops a grammy bot
// from creeping back into the Runner process, where a second long-poll against
// the same token would silently steal updates from the Manager adapter.

const srcDir = new URL("../src/", import.meta.url);

async function source(file: string): Promise<string> {
  return fs.readFile(new URL(file, srcDir), "utf8");
}

async function allSources(): Promise<Array<[string, string]>> {
  const names = (await fs.readdir(srcDir)).filter((name) => name.endsWith(".ts"));
  return Promise.all(names.map(async (name) => [name, await source(name)] as [string, string]));
}

test("el bot de Telegram del Runner ha desaparecido (src/telegram.ts no existe)", async () => {
  await assert.rejects(() => fs.access(new URL("telegram.ts", srcDir)), (error: Error) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
});

test("ningún fichero del Runner importa grammy ni arranca un bot", async () => {
  for (const [name, text] of await allSources()) {
    assert.equal(
      /from\s+"grammy"/.test(text),
      false,
      `${name} vuelve a importar grammy: el bot lo posee el Manager`,
    );
    assert.equal(
      /startTelegram|new Bot\(/.test(text),
      false,
      `${name} vuelve a construir un bot`,
    );
  }
});

test("ningún fichero del Runner lee config.telegramToken (cutover R3)", async () => {
  for (const [name, text] of await allSources()) {
    assert.equal(
      text.includes("telegramToken"),
      false,
      `${name} sigue leyendo el token legado de agent.json`,
    );
  }
});

test("loadEnv: PIHUB_CHANNEL_KINDS es la señal de canales que inyecta el Manager", () => {
  assert.deepEqual(loadEnv({}).channelKinds, []);
  assert.deepEqual(
    loadEnv({ PIHUB_CHANNEL_KINDS: "telegram, , whatsapp ,telegram" }).channelKinds,
    ["telegram", "whatsapp"],
  );
});

test("la presencia de canal para el prompt/status del Runner sale de env, no del config", async () => {
  const [session, server, index] = await Promise.all([
    source("session.ts"),
    source("server.ts"),
    source("index.ts"),
  ]);
  for (const [name, text] of [
    ["session.ts", session],
    ["server.ts", server],
  ] as const) {
    assert.match(text, /channelKinds/, `${name} perdió la señal de canales`);
  }
  assert.equal(index.includes("telegram.js"), false, "index.ts sigue cableando el bot");
  assert.equal(index.includes("startTelegram"), false, "index.ts sigue arrancando el bot");
});

test("el Runner sigue siendo un extremo de turnos: el resto del surface intacto", async () => {
  // Solo un recordatorio de que el corte es QUÍRURGICO: sesiones, herramientas y
  // subida de archivos no se tocan en este slice.
  const server = await source("server.ts");
  assert.match(server, /\/api\/upload/);
  assert.match(server, /attachWebSocket/);
  assert.match(server, /\/api\/transcribe/);
  const session = await source("session.ts");
  assert.match(session, /class SessionFactory/);
});
