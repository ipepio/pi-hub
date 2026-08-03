import type { ModelInfo } from "@pihub/shared";
import type { RuntimeProviders } from "@pihub/providers";

/** Catálogo público derivado exclusivamente del Module de Runtime Providers. */
export async function listModels(providers: RuntimeProviders): Promise<ModelInfo[]> {
  return (await providers.snapshot()).models;
}
