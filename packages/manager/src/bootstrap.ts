import { promises as fs } from "node:fs";
import path from "node:path";
import {
  dataPaths,
  piInstall,
  scaffoldGlobalDirs,
  type PihubEnv,
} from "@pihub/shared";
import { memoryExtensionSource, modelsSeedFile } from "./paths.js";

async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

async function installedPackages(settingsFile: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile, "utf8")) as {
      packages?: Array<string | { source?: string }>;
    };
    const sources = (raw.packages ?? []).map((p) => (typeof p === "string" ? p : p.source ?? ""));
    return new Set(sources.filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Prepara /data en el arranque: dirs, seed de models.json, extensión de memoria y stack global. */
export async function bootstrap(env: PihubEnv): Promise<void> {
  const paths = await scaffoldGlobalDirs(env.dataDir);

  // Seed de models.json desde el repo (PIHUB_OVERWRITE_MODELS manda sobre el volumen)
  const modelsTarget = path.join(paths.globalDir, "models.json");
  if (await exists(modelsSeedFile)) {
    if (env.overwriteModels || !(await exists(modelsTarget))) {
      await fs.copyFile(modelsSeedFile, modelsTarget);
      console.log(`[bootstrap] models.json seeded en ${modelsTarget}`);
    }
  }

  // Extensión de memoria: se sincroniza siempre con la versión de la imagen
  const memoryTarget = path.join(paths.globalDir, "extensions", "pihub-memory.ts");
  if (env.memoryEnabled) {
    if (await exists(memoryExtensionSource)) {
      await fs.copyFile(memoryExtensionSource, memoryTarget);
    } else {
      console.warn(`[bootstrap] no se encontró ${memoryExtensionSource}`);
    }
  } else if (await exists(memoryTarget)) {
    await fs.unlink(memoryTarget);
  }

  // Stack inicial de paquetes globales (idempotente: el volumen manda)
  if (env.globalPackages.length > 0) {
    const settingsFile = path.join(paths.globalDir, "settings.json");
    const installed = await installedPackages(settingsFile);
    for (const source of env.globalPackages) {
      if (installed.has(source)) continue;
      console.log(`[bootstrap] instalando paquete global ${source}...`);
      const result = await piInstall(env.dataDir, source);
      if (!result.ok) {
        console.error(`[bootstrap] fallo instalando ${source}: ${result.stderr.slice(0, 500)}`);
      }
    }
  }
}
