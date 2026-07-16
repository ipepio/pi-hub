import { Bot, InputFile, type Context } from "grammy";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, PihubEnv } from "@pihub/shared";
import type { SessionFactory } from "./session.js";
import { speakable, sttEnabled, synthesize, transcribe, ttsEnabled } from "./speech.js";

const EDIT_INTERVAL_MS = 2500;
const TG_LIMIT = 4096;

/** Bot de Telegram del agente: comandos + lenguaje natural, una sesión pi por chat. */
export function startTelegram(
  env: PihubEnv,
  config: AgentConfig,
  factory: SessionFactory,
): { stop: () => void } | undefined {
  if (!config.telegramToken) return undefined;

  const bot = new Bot(config.telegramToken);
  const sessions = new Map<number, AgentSession>();
  const startedAt = Date.now();

  const allowed = (ctx: Context): boolean => {
    if (env.telegramAllowedUsers.length === 0) return true;
    return !!ctx.from && env.telegramAllowedUsers.includes(ctx.from.id);
  };

  async function getSession(chatId: number): Promise<AgentSession> {
    let session = sessions.get(chatId);
    if (!session) {
      session = await factory.create();
      sessions.set(chatId, session);
    }
    return session;
  }

  bot.use(async (ctx, next) => {
    if (!allowed(ctx)) {
      await ctx.reply("No autorizado.");
      return;
    }
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      `Hola, soy el agente "${config.name}".\n` +
        `Háblame en lenguaje natural o usa:\n` +
        `/new — nueva sesión\n/status — estado\n/model <proveedor/id> — cambiar modelo\n/stop — abortar la respuesta en curso`,
    ),
  );

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    sessions.get(chatId)?.dispose();
    sessions.delete(chatId);
    await ctx.reply("Sesión nueva. Empezamos de cero.");
  });

  bot.command("status", async (ctx) => {
    const session = sessions.get(ctx.chat.id);
    const model = session?.model as { provider?: string; id?: string } | undefined;
    const modelId = model?.provider ? `${model.provider}/${model.id}` : config.model ?? "(por defecto)";
    const uptimeMin = Math.round((Date.now() - startedAt) / 60000);
    await ctx.reply(
      `Agente: ${config.name}\nModelo: ${modelId}\nSesión: ${session ? session.sessionId : "(ninguna)"}\n` +
        `Generando: ${session?.isStreaming ? "sí" : "no"}\nUptime runner: ${uptimeMin} min`,
    );
  });

  bot.command("model", async (ctx) => {
    const spec = (ctx.match ?? "").trim();
    if (!spec) {
      await ctx.reply("Uso: /model proveedor/id — p.ej. /model anthropic/claude-sonnet-5");
      return;
    }
    const model = factory.resolveModel(spec);
    if (!model) {
      await ctx.reply(`No conozco el modelo "${spec}". Formato: proveedor/id`);
      return;
    }
    const session = await getSession(ctx.chat.id);
    await session.setModel(model);
    await ctx.reply(`Modelo cambiado a ${spec} para este chat.`);
  });

  bot.command("stop", async (ctx) => {
    await sessions.get(ctx.chat.id)?.abort();
    await ctx.reply("Abortado.");
  });

  /** Responde a un prompt con streaming (edita el placeholder) y devuelve el texto final. */
  async function respondTo(ctx: Context, promptText: string): Promise<string> {
    const chatId = ctx.chat!.id;
    const session = await getSession(chatId);
    const placeholder = await ctx.reply("⏳ …");

    let buffer = "";
    let lastEdit = 0;
    let lastSent = "";
    let editing = false;

    const maybeEdit = async (force: boolean) => {
      const now = Date.now();
      if (editing || (!force && now - lastEdit < EDIT_INTERVAL_MS)) return;
      const text = buffer.trim().slice(0, TG_LIMIT - 2) || "⏳ …";
      if (text === lastSent) return;
      editing = true;
      lastEdit = now;
      try {
        await ctx.api.editMessageText(chatId, placeholder.message_id, text);
        lastSent = text;
      } catch {
        // "message is not modified" y rate limits: se ignoran
      } finally {
        editing = false;
      }
    };

    const typing = setInterval(() => {
      void ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 5000);
    void ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const e = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
          .assistantMessageEvent;
        if (e?.type === "text_delta" && e.delta) {
          buffer += e.delta;
          void maybeEdit(false);
        }
      } else if (event.type === "tool_execution_start") {
        const toolName = (event as { toolName?: string }).toolName ?? "tool";
        void ctx.api
          .sendChatAction(chatId, "typing")
          .catch(() => {});
        if (!buffer) {
          buffer = "";
          void ctx.api
            .editMessageText(chatId, placeholder.message_id, `🔧 ${toolName}…`)
            .catch(() => {});
        }
      }
    });

    try {
      const options = session.isStreaming ? ({ streamingBehavior: "followUp" } as const) : undefined;
      await session.prompt(promptText, options);
    } catch (error) {
      buffer = `⚠️ Error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearInterval(typing);
      unsubscribe();
    }

    // Entrega final: primer trozo edita el placeholder, el resto en mensajes nuevos
    const full = buffer.trim() || "(sin respuesta)";
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += TG_LIMIT) chunks.push(full.slice(i, i + TG_LIMIT));
    try {
      if (chunks[0] !== lastSent) {
        await ctx.api.editMessageText(chatId, placeholder.message_id, chunks[0]);
      }
      for (const chunk of chunks.slice(1)) await ctx.reply(chunk);
    } catch {
      // último intento fallido: no rompemos el handler
    }
    return full;
  }

  bot.on("message:text", async (ctx) => {
    await respondTo(ctx, ctx.message.text);
  });

  // Notas de voz y archivos de audio: transcribir (STT), responder, y si hay TTS
  // devolver la respuesta también como nota de voz. El audio nunca se guarda.
  bot.on(["message:voice", "message:audio"], async (ctx) => {
    if (!sttEnabled(env)) {
      await ctx.reply("Este agente no tiene voz configurada (falta STT en la plataforma).");
      return;
    }
    const media = ctx.message.voice ?? ctx.message.audio;
    if (!media) return;
    try {
      const file = await ctx.api.getFile(media.file_id);
      if (!file.file_path) throw new Error("Telegram no devolvió la ruta del audio");
      const download = await fetch(
        `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`,
      );
      if (!download.ok) throw new Error(`descarga fallida (${download.status})`);
      const audio = Buffer.from(await download.arrayBuffer());
      const text = await transcribe(env, audio, file.file_path.split("/").pop() ?? "voice.oga", media.mime_type ?? "audio/ogg");
      if (!text) {
        await ctx.reply("No he entendido nada en el audio.");
        return;
      }
      await ctx.reply(`🎙 «${text.slice(0, 500)}»`);
      const answer = await respondTo(ctx, text);

      if (ttsEnabled(env) && answer && !answer.startsWith("⚠️")) {
        const speech = speakable(answer);
        if (speech) {
          const voice = await synthesize(env, speech, config.ttsVoice ?? env.ttsVoice);
          await ctx.replyWithVoice(new InputFile(voice, "respuesta.ogg"));
        }
      }
    } catch (error) {
      console.error(`[telegram:${config.name}] audio:`, error);
      await ctx.reply(`⚠️ No pude procesar el audio: ${(error as Error).message}`);
    }
  });

  void bot.api
    .setMyCommands([
      { command: "new", description: "Nueva sesión" },
      { command: "status", description: "Estado del agente" },
      { command: "model", description: "Cambiar modelo (proveedor/id)" },
      { command: "stop", description: "Abortar respuesta en curso" },
    ])
    .catch(() => {});

  bot.catch((error) => console.error(`[telegram:${config.name}]`, error.message));
  void bot.start({ drop_pending_updates: true });
  console.log(`[telegram:${config.name}] bot iniciado`);

  return {
    stop: () => {
      void bot.stop();
      for (const session of sessions.values()) session.dispose();
    },
  };
}
