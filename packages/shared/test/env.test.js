import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv, parseSharedMemoryAccess } from "../dist/env.js";
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
