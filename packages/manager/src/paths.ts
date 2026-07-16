import path from "node:path";
import { fileURLToPath } from "node:url";

/** Raíz del repo/instalación de pihub (dos niveles sobre packages/manager/dist). */
export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const runnerEntry = path.join(appRoot, "packages", "runner", "dist", "index.js");
export const memoryExtensionSource = path.join(
  appRoot,
  "packages",
  "memory-extension",
  "src",
  "pihub-memory.ts",
);
export const modelsSeedFile = path.join(appRoot, "models.json");
export const panelDir = path.join(appRoot, "packages", "manager", "public");
