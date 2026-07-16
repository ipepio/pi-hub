import type { PihubEnv } from "@pihub/shared";

/**
 * Cliente del servidor de audio OpenAI-compatible (speaches, LocalAI...):
 * whisper vía /v1/audio/transcriptions y kokoro vía /v1/audio/speech.
 * Los audios nunca tocan disco: entran y salen como buffers en memoria.
 */

export const sttEnabled = (env: PihubEnv): boolean => Boolean(env.speechUrl && env.sttModel);
export const ttsEnabled = (env: PihubEnv): boolean => Boolean(env.speechUrl && env.ttsModel);

function authHeaders(env: PihubEnv): Record<string, string> {
  return env.speechApiKey ? { authorization: `Bearer ${env.speechApiKey}` } : {};
}

export async function transcribe(
  env: PihubEnv,
  audio: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  if (!sttEnabled(env)) throw new Error("STT no configurado (PIHUB_SPEECH_URL + PIHUB_STT_MODEL)");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  form.append("model", env.sttModel as string);
  const response = await fetch(`${env.speechUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: authHeaders(env),
    body: form,
  });
  if (!response.ok) {
    throw new Error(`STT falló (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { text?: string };
  return (body.text ?? "").trim();
}

/** Sintetiza voz (OGG/Opus, apto para notas de voz de Telegram). */
export async function synthesize(env: PihubEnv, text: string, voice?: string): Promise<Buffer> {
  if (!ttsEnabled(env)) throw new Error("TTS no configurado (PIHUB_SPEECH_URL + PIHUB_TTS_MODEL)");
  const response = await fetch(`${env.speechUrl}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(env) },
    body: JSON.stringify({
      model: env.ttsModel,
      input: text,
      response_format: "opus",
      // kokoro devuelve 500 si no se manda voz: siempre una explícita
      voice: voice || "af_heart",
    }),
  });
  if (!response.ok) {
    throw new Error(`TTS falló (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Texto legible para TTS: fuera markdown, código y URLs; acotado. */
export function speakable(markdown: string, maxChars = 3000): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " (código) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " (enlace) ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}
