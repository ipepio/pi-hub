import { promises as fs } from "node:fs";
import { z } from "zod";
import { agentPaths, piInstall, readAgent, type PihubEnv } from "@pihub/shared";
import {
  createAgent,
  listPackages,
  readSystemPrompt,
  updateAgent,
  type UpdateAgentInput,
} from "./agents.js";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const sharedMemoryAccessValues = ["none", "read", "read-write"] as const;

    const manifestAgentSchema = z.object({
      name: z.string(),
      model: z.string().optional(),
      thinkingLevel: z.enum(thinkingLevels).optional(),
      /**
       * LEGADO (cutover channels-and-mcp, part 3b). Se sigue aceptando solo para
       * poder avisar: un manifiesto con `telegramToken` ya NO configura un bot —
       * el canal es una entidad del Manager (PUT /api/v1/agents/:name/channels)
       * y su credencial nunca se escribe en `agent.json`.
       */
      telegramToken: z.string().optional(),
      ttsVoice: z.string().optional(),
  memory: z.object({ sharedAccess: z.enum(sharedMemoryAccessValues).optional() }).optional(),
  systemPrompt: z.string().optional(),
  systemPromptFile: z.string().optional(),
  packages: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

const manifestSchema = z.object({ agents: z.array(manifestAgentSchema) });

type ManifestAgent = z.infer<typeof manifestAgentSchema>;

/** Sustituye ${VAR} por process.env.VAR; deja el literal si la variable no existe. */
function interpolate(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => process.env[name] ?? match);
}

const log = (message: string): void => console.log(`[provision] ${message}`);
const warn = (message: string): void => console.error(`[provision] ${message}`);

/**
 * Provisión declarativa de agentes desde PIHUB_AGENTS_FILE (manifiesto JSON).
 * Idempotente: crea los que falten, actualiza solo campos presentes que difieran,
 * instala paquetes que falten. Nunca borra agentes ni desinstala paquetes, nunca
 * resetea campos ausentes del manifiesto, y nunca tumba el arranque del manager.
 */
export async function provisionAgents(env: PihubEnv): Promise<void> {
  if (!env.agentsFile) return;

  let entries: ManifestAgent[];
  try {
    const raw = await fs.readFile(env.agentsFile, "utf8");
    const parsed = manifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      warn(`manifiesto inválido (${env.agentsFile}): ${parsed.error.message}`);
      return;
    }
    entries = parsed.data.agents;
  } catch (error) {
    warn(`no se pudo leer ${env.agentsFile}: ${(error as Error).message}`);
    return;
  }

  for (const entry of entries) {
    try {
      await provisionOne(env, entry);
    } catch (error) {
      warn(`error provisionando "${entry.name}": ${(error as Error).message}`);
    }
  }
}

async function provisionOne(env: PihubEnv, raw: ManifestAgent): Promise<void> {
  const entry: ManifestAgent = {
    ...raw,
    model: raw.model !== undefined ? interpolate(raw.model) : undefined,
    systemPrompt: raw.systemPrompt !== undefined ? interpolate(raw.systemPrompt) : undefined,
    systemPromptFile: raw.systemPromptFile !== undefined ? interpolate(raw.systemPromptFile) : undefined,
  };

  // Cutover R3: el campo se descarta aquí mismo — no se interpola (un `${VAR}` de
  // secreto no debe resolverse nunca para algo que no se escribe) y no llega a
  // `createAgent`/`updateAgent`, que ya no lo aceptan.
  if (entry.telegramToken !== undefined) {
    warn(
      `"${entry.name}": telegramToken es legado y se ignora; configura el canal ` +
        `con PUT /api/v1/agents/${entry.name}/channels (el bot lo posee el Manager)`,
    );
  }

  let systemPrompt = entry.systemPrompt;
  if (systemPrompt === undefined && entry.systemPromptFile) {
    try {
      systemPrompt = await fs.readFile(entry.systemPromptFile, "utf8");
    } catch (error) {
      warn(`"${entry.name}": no se pudo leer systemPromptFile: ${(error as Error).message}`);
    }
  }

  const existing = await readAgent(env.dataDir, entry.name);

  if (!existing) {
    await createAgent(env, {
      name: entry.name,
      model: entry.model,
      thinkingLevel: entry.thinkingLevel,
      systemPrompt,
      ttsVoice: entry.ttsVoice,
      memory: entry.memory,
      packages: entry.packages,
    });
    if (entry.enabled === false) await updateAgent(env, entry.name, { enabled: false });
    log(`agente "${entry.name}" creado`);
    return;
  }

  // Diff mínimo: solo campos presentes en el manifiesto que difieran del estado actual.
  const patch: UpdateAgentInput = {};
  if (entry.model !== undefined && entry.model !== existing.model) patch.model = entry.model;
  if (entry.thinkingLevel !== undefined && entry.thinkingLevel !== existing.thinkingLevel) {
    patch.thinkingLevel = entry.thinkingLevel;
  }
  if (entry.ttsVoice !== undefined && entry.ttsVoice !== existing.ttsVoice) patch.ttsVoice = entry.ttsVoice;
  if (entry.memory !== undefined && entry.memory.sharedAccess !== existing.memory?.sharedAccess) {
    patch.memory = entry.memory;
  }
  if (entry.enabled !== undefined && entry.enabled !== existing.enabled) patch.enabled = entry.enabled;
  if (systemPrompt !== undefined && systemPrompt !== (await readSystemPrompt(env, entry.name))) {
    patch.systemPrompt = systemPrompt;
  }

  if (Object.keys(patch).length) {
    await updateAgent(env, entry.name, patch);
    log(`agente "${entry.name}" actualizado: ${Object.keys(patch).join(", ")}`);
  } else {
    log(`agente "${entry.name}" sin cambios`);
  }

  if (entry.packages?.length) {
    const installed = new Set(await listPackages(env, entry.name));
    const workspaceDir = agentPaths(env.dataDir, entry.name).workspaceDir;
    for (const source of entry.packages) {
      if (installed.has(source)) continue;
      const result = await piInstall(env.dataDir, source, workspaceDir);
      if (result.ok) log(`"${entry.name}": paquete ${source} instalado`);
      else warn(`"${entry.name}": fallo instalando ${source}: ${result.stderr.slice(0, 300)}`);
    }
  }
}
