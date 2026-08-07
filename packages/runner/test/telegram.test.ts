import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedUser, warnIfNoAllowlist } from "../dist/telegram.js";

test("isAllowedUser con allowlist poblada: rechaza no listados, acepta listados", () => {
  const allowlist = [111, 222];

  // Acepta los que están en la lista
  assert.equal(isAllowedUser(allowlist, 111), true);
  assert.equal(isAllowedUser(allowlist, 222), true);

  // Rechaza los que no están
  assert.equal(isAllowedUser(allowlist, 333), false);
  assert.equal(isAllowedUser(allowlist, 0), false);

  // Rechaza si no hay from (ctx.from undefined)
  assert.equal(isAllowedUser(allowlist, undefined), false);
});

test("isAllowedUser con allowlist vacía: acepta a cualquiera", () => {
  assert.equal(isAllowedUser([], 999), true);
  assert.equal(isAllowedUser([], 0), true);
  assert.equal(isAllowedUser([], undefined), true);
});

test("warnIfNoAllowlist emite el aviso por console.warn con allowlist vacía", () => {
  const messages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => messages.push(msg);

  try {
    warnIfNoAllowlist("test-agent", []);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes("sin allowlist"));
    assert.ok(messages[0].includes("test-agent"));
    assert.ok(messages[0].includes("cualquier usuario"));
  } finally {
    console.warn = originalWarn;
  }
});

test("warnIfNoAllowlist no emite aviso si la allowlist tiene usuarios", () => {
  const messages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => messages.push(msg);

  try {
    warnIfNoAllowlist("test-agent", [111, 222]);
    assert.equal(messages.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});