import test from "node:test";
import assert from "node:assert/strict";
import { diffPackages } from "../dist/api-v1/package-sync.js";

test("diffPackages: conjuntos idénticos no dan nada que instalar ni quitar", () => {
  assert.deepEqual(diffPackages(["a", "b"], ["b", "a"]), { toInstall: [], toRemove: [] });
});

test("diffPackages: un paquete nuevo en el deseado va a toInstall", () => {
  assert.deepEqual(diffPackages(["a"], ["a", "b"]), { toInstall: ["b"], toRemove: [] });
});

test("diffPackages: un paquete ausente del deseado va a toRemove", () => {
  assert.deepEqual(diffPackages(["a", "b"], ["a"]), { toInstall: [], toRemove: ["b"] });
});

test("diffPackages: conjunto vacío deseado quita todo lo instalado", () => {
  assert.deepEqual(diffPackages(["a", "b"], []), { toInstall: [], toRemove: ["a", "b"] });
});

test("diffPackages: nada instalado con un conjunto deseado instala todo", () => {
  assert.deepEqual(diffPackages([], ["a", "b"]), { toInstall: ["a", "b"], toRemove: [] });
});
