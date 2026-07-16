import test from "node:test";
import assert from "node:assert/strict";
import { buildMemorySection } from "../dist/prompt.js";

const base = { memoryEnabled: true, agentIndex: "- **a**: A — nota privada", sharedIndex: "- **s**: S — nota compartida" };

test("memoryEnabled=false devuelve cadena vacía", () => {
  assert.equal(buildMemorySection({ ...base, memoryEnabled: false, sharedAccess: "read-write" }), "");
});

test("none: solo memoria privada, cero menciones a Shared Memory", () => {
  const section = buildMemorySection({ ...base, sharedAccess: "none", sharedIndex: "" });
  assert.match(section, /Índice de memoria del agente/);
  assert.match(section, /nota privada/);
  assert.doesNotMatch(section, /shared/i);
  assert.match(section, /scope `agent`/);
});

test("read: ambos índices y escritura solo en agent", () => {
  const section = buildMemorySection({ ...base, sharedAccess: "read" });
  assert.match(section, /nota privada/);
  assert.match(section, /nota compartida/);
  assert.match(section, /solo lectura/);
  assert.match(section, /escrituras en `shared` serán rechazadas/);
});

test("read-write: ambos índices e instrucción de guardado compartido", () => {
  const section = buildMemorySection({ ...base, sharedAccess: "read-write" });
  assert.match(section, /nota privada/);
  assert.match(section, /nota compartida/);
  assert.match(section, /`shared` solo para lo que sirva a todos/);
  assert.doesNotMatch(section, /solo lectura/);
});

test("ningún nivel usa 'global' como término de producto", () => {
  for (const sharedAccess of ["none", "read", "read-write"]) {
    const section = buildMemorySection({ ...base, sharedAccess });
    assert.doesNotMatch(section, /global/i, `nivel ${sharedAccess} menciona "global"`);
  }
});

test("índices vacíos se muestran como (vacía)", () => {
  const section = buildMemorySection({ memoryEnabled: true, sharedAccess: "read", agentIndex: "", sharedIndex: "" });
  assert.match(section, /\(vacía\)/);
});
