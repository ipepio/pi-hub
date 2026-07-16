import path from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { dataPaths, type ModelInfo, type PihubEnv } from "@pihub/shared";

/**
 * Modelos disponibles según /data/global/models.json + built-ins de pi, con su
 * estado de credenciales. Se crea el registry por petición (igual que hace el
 * runner en SessionFactory) para recoger cambios del archivo sin reiniciar.
 * Solo lectura: los providers se gestionan por env/archivos/CLI, nunca por UI.
 */
export function listModels(env: PihubEnv): ModelInfo[] {
  const globalDir = dataPaths(env.dataDir).globalDir;
  const registry = ModelRegistry.create(
    AuthStorage.create(path.join(globalDir, "auth.json")),
    path.join(globalDir, "models.json"),
  );
  return registry.getAll().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    configured: registry.hasConfiguredAuth(model),
  }));
}
