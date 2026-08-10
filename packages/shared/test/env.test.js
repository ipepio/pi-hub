import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv, parseSharedMemoryAccess, parseTelegramPrimaryChatId } from "../dist/env.js";
import { resolveSharedMemoryAccess } from "../dist/memory.js";

test("parseSharedMemoryAccess: sin valor o vacío devuelve none", () => {
  assert.equal(parseSharedMemoryAccess(undefined), "none");
  assert.equal(parseSharedMemoryAccess(""), "none");
});

test("parseSharedMemoryAccess: acepta los tres niveles", () => {
  assert.equal(parseSharedMemoryAccess("none"), "none");
  assert.equal(parseSharedMemoryAccess("read"), "read");
  assert.equal(parseSharedMemoryAccess("read-write"), "read-write");
});

test("parseSharedMemoryAccess: valor inválido lanza", () => {
  assert.throws(() => parseSharedMemoryAccess("all"), /PIHUB_SHARED_MEMORY_DEFAULT inválido/);
});

test("loadEnv: PIHUB_SHARED_MEMORY_DEFAULT se parsea y su ausencia es none", () => {
  assert.equal(loadEnv({}).sharedMemoryDefault, "none");
  assert.equal(loadEnv({ PIHUB_SHARED_MEMORY_DEFAULT: "read" }).sharedMemoryDefault, "read");
});

test("resolveSharedMemoryAccess: el override del agente gana al default", () => {
  const env = { sharedMemoryDefault: "none" };
  assert.equal(resolveSharedMemoryAccess({ memory: { sharedAccess: "read-write" } }, env), "read-write");
  assert.equal(resolveSharedMemoryAccess({ memory: { sharedAccess: "none" } }, { sharedMemoryDefault: "read" }), "none");
});

test("resolveSharedMemoryAccess: sin override aplica el default de runtime", () => {
  assert.equal(resolveSharedMemoryAccess({}, { sharedMemoryDefault: "read" }), "read");
  assert.equal(resolveSharedMemoryAccess({ memory: {} }, { sharedMemoryDefault: "none" }), "none");
});

test("loadEnv: defaults del Loop (Fase 3.7, §9.7)", () => {
  const env = loadEnv({});
  assert.equal(env.loopConcurrency, 1);
  assert.equal(env.loopPollMs, 1000);
  assert.equal(env.loopGraceMs, 5000);
  assert.equal(env.loopPostAbortMarginMs, 1000);
  // Punto crítico de la sub-fase: `dispatchTimeoutMs` debe tener un default
  // real y NO cero desde env (`0` significa watchdog desactivado).
  assert.ok(env.turnDispatchTimeoutMs > 0);
  // Caducidad de `waiting_human` (§6): 7 días, el default del dominio.
  assert.equal(env.waitingHumanExpiryMs, 604_800_000);
});

test("loadEnv: PIHUB_LOOP_* y PIHUB_TURN_DISPATCH_TIMEOUT_MS se leen", () => {
  const env = loadEnv({
    PIHUB_LOOP_CONCURRENCY: "3",
    PIHUB_LOOP_POLL_MS: "250",
    PIHUB_LOOP_GRACE_MS: "0",
    PIHUB_LOOP_POST_ABORT_MARGIN_MS: "500",
    PIHUB_TURN_DISPATCH_TIMEOUT_MS: "120000",
    PIHUB_WAITING_HUMAN_EXPIRY_MS: "1209600000",
  });
  assert.equal(env.loopConcurrency, 3);
  assert.equal(env.loopPollMs, 250);
  assert.equal(env.loopGraceMs, 0);
  assert.equal(env.loopPostAbortMarginMs, 500);
  assert.equal(env.turnDispatchTimeoutMs, 120000);
  assert.equal(env.waitingHumanExpiryMs, 1_209_600_000);
});

test("loadEnv: valores de Loop inválidos lanzan", () => {
  assert.throws(() => loadEnv({ PIHUB_LOOP_CONCURRENCY: "0" }), /PIHUB_LOOP_CONCURRENCY inválido/);
  assert.throws(() => loadEnv({ PIHUB_LOOP_CONCURRENCY: "abc" }), /PIHUB_LOOP_CONCURRENCY inválido/);
  assert.throws(() => loadEnv({ PIHUB_LOOP_POLL_MS: "0" }), /PIHUB_LOOP_POLL_MS inválido/);
  assert.throws(() => loadEnv({ PIHUB_LOOP_GRACE_MS: "-1" }), /PIHUB_LOOP_GRACE_MS inválido/);
  assert.throws(() => loadEnv({ PIHUB_TURN_DISPATCH_TIMEOUT_MS: "x" }), /PIHUB_TURN_DISPATCH_TIMEOUT_MS inválido/);
  // `waitingHumanExpiryMs` es positiveInt: 0 significaría caducar al instante.
  assert.throws(() => loadEnv({ PIHUB_WAITING_HUMAN_EXPIRY_MS: "0" }), /PIHUB_WAITING_HUMAN_EXPIRY_MS inválido/);
  assert.throws(() => loadEnv({ PIHUB_WAITING_HUMAN_EXPIRY_MS: "-1" }), /PIHUB_WAITING_HUMAN_EXPIRY_MS inválido/);
});

test("parseTelegramPrimaryChatId: ausente o vacío devuelve undefined (panel-only)", () => {
  assert.equal(parseTelegramPrimaryChatId(undefined, [111]), undefined);
  assert.equal(parseTelegramPrimaryChatId("", [111]), undefined);
});

test("parseTelegramPrimaryChatId: válido (positivo y miembro de la allowlist)", () => {
  assert.equal(parseTelegramPrimaryChatId("222", [111, 222]), 222);
});

test("parseTelegramPrimaryChatId: no numérico o no entero lanza", () => {
  assert.throws(() => parseTelegramPrimaryChatId("abc", [111]), /PIHUB_TELEGRAM_PRIMARY_CHAT_ID inválido/);
  assert.throws(() => parseTelegramPrimaryChatId("12.5", [111]), /PIHUB_TELEGRAM_PRIMARY_CHAT_ID inválido/);
});

test("parseTelegramPrimaryChatId: negativo (grupo/canal) o cero lanza", () => {
  assert.throws(() => parseTelegramPrimaryChatId("-1001234567890", [111]), /PIHUB_TELEGRAM_PRIMARY_CHAT_ID inválido/);
  assert.throws(() => parseTelegramPrimaryChatId("0", [111]), /PIHUB_TELEGRAM_PRIMARY_CHAT_ID inválido/);
});

test("parseTelegramPrimaryChatId: fuera de la allowlist lanza", () => {
  assert.throws(
    () => parseTelegramPrimaryChatId("333", [111, 222]),
    /PIHUB_TELEGRAM_PRIMARY_CHAT_ID=333 no está en PIHUB_TELEGRAM_ALLOWED_USERS/,
  );
});

test("parseTelegramPrimaryChatId: allowlist vacía con primary lanza (fail-closed)", () => {
  assert.throws(
    () => parseTelegramPrimaryChatId("111", []),
    /PIHUB_TELEGRAM_ALLOWED_USERS no vacía/,
  );
});

test("loadEnv: PIHUB_TELEGRAM_PRIMARY_CHAT_ID ausente es undefined (panel-only)", () => {
  assert.equal(loadEnv({}).telegramPrimaryChatId, undefined);
  assert.equal(loadEnv({ PIHUB_TELEGRAM_ALLOWED_USERS: "111,222" }).telegramPrimaryChatId, undefined);
});

test("loadEnv: PIHUB_TELEGRAM_PRIMARY_CHAT_ID válido se parsea", () => {
  const env = loadEnv({ PIHUB_TELEGRAM_ALLOWED_USERS: "111,222", PIHUB_TELEGRAM_PRIMARY_CHAT_ID: "222" });
  assert.equal(env.telegramPrimaryChatId, 222);
});

test("loadEnv: PIHUB_TELEGRAM_PRIMARY_CHAT_ID fuera de la allowlist lanza", () => {
  assert.throws(
    () => loadEnv({ PIHUB_TELEGRAM_ALLOWED_USERS: "111,222", PIHUB_TELEGRAM_PRIMARY_CHAT_ID: "333" }),
    /PIHUB_TELEGRAM_PRIMARY_CHAT_ID=333 no está en PIHUB_TELEGRAM_ALLOWED_USERS/,
  );
});

test("loadEnv: allowlist vacía con primary lanza (fail-closed)", () => {
  assert.throws(
    () => loadEnv({ PIHUB_TELEGRAM_PRIMARY_CHAT_ID: "111" }),
    /PIHUB_TELEGRAM_ALLOWED_USERS no vacía/,
  );
});
