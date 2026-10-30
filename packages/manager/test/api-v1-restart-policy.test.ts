import test from "node:test";
import assert from "node:assert/strict";
import {
  agentRuntimeFingerprint,
  decideRuntimeAction,
  hasLiveTurnForAgent,
  projectSystemPrompt,
  projectUpdatedAgent,
} from "../dist/api-v1/restart-policy.js";

// H-parity: el PATCH de /api/v1 solo reiniciaba el Runner si cambiaba el
// telegramToken. El dashboard reconcilia mandando el estado COMPLETO en cada
// llamada, así que un cambio de Model o de Persona se persistía sin que el
// Runner en marcha se enterara nunca. La huella cubre TODO lo que el Runner
// lee al arrancar (ver runnerEnvFor/spawnRunner en supervisor.ts +
// readSystemPrompt en agents.ts): si dos huellas coinciden, reiniciar no
// cambiaría nada observable y por tanto no se reinicia.

function baseSnapshot() {
  const base = {
    model: "anthropic/claude-sonnet-5",
    thinkingLevel: "medium" as const,
    ttsVoice: "af_heart",
    memory: { sharedAccess: "read" as const },
    systemPrompt: "Eres un asistente.",
    env: { FOO: "bar" },
    packages: ["npm:@scope/skill"],
    channels: [{ kind: "telegram" as const, label: "personal", tokenDigest: "digest-1" }],
  };
  // Cutover (slice (c) part 3b): `telegramToken` salió del snapshot. El campo
  // sigue aceptándose como propiedad desconocida para que un caller que aún lo
  // mande no rompa contra `tsc`, pero la huella lo ignora por completo.
  return base as typeof base & { telegramToken?: string };
}

test("agentRuntimeFingerprint: dos snapshots idénticos dan la misma huella", () => {
  assert.equal(agentRuntimeFingerprint(baseSnapshot()), agentRuntimeFingerprint(baseSnapshot()));
});

test("agentRuntimeFingerprint: el orden de las claves de env no importa", () => {
  const a = { ...baseSnapshot(), env: { A: "1", B: "2" } };
  const b = { ...baseSnapshot(), env: { B: "2", A: "1" } };
  assert.equal(agentRuntimeFingerprint(a), agentRuntimeFingerprint(b));
});

test("agentRuntimeFingerprint: el orden de packages no importa", () => {
  const a = { ...baseSnapshot(), packages: ["npm:x", "npm:y"] };
  const b = { ...baseSnapshot(), packages: ["npm:y", "npm:x"] };
  assert.equal(agentRuntimeFingerprint(a), agentRuntimeFingerprint(b));
});

// Un caso por CADA campo que el Runner lee al arrancar. Si falta uno aquí,
// ese campo puede cambiar sin que el Runner se reinicie nunca — el bug 1
// reaparecido en silencio.
const camposDeArranque: Array<[string, (s: ReturnType<typeof baseSnapshot>) => typeof s]> = [
  ["model", (s) => ({ ...s, model: "openai/gpt-5" })],
  ["thinkingLevel", (s) => ({ ...s, thinkingLevel: "high" })],
  ["ttsVoice", (s) => ({ ...s, ttsVoice: "otra-voz" })],
  ["memory.sharedAccess", (s) => ({ ...s, memory: { sharedAccess: "none" } })],
  ["systemPrompt", (s) => ({ ...s, systemPrompt: "Otra persona." })],
  ["env (valor)", (s) => ({ ...s, env: { FOO: "otro-valor" } })],
  ["env (clave nueva)", (s) => ({ ...s, env: { ...s.env, NUEVA: "x" } })],
  ["env (clave quitada)", (s) => ({ ...s, env: {} })],
  ["packages (añadido)", (s) => ({ ...s, packages: [...s.packages, "npm:@scope/otro"] })],
  ["packages (quitado)", (s) => ({ ...s, packages: [] })],
  ["channels (digest rotado)", (s) => ({
    ...s,
    channels: [{ ...s.channels[0], tokenDigest: "digest-2" }],
  })],
  ["channels (añadido)", (s) => ({
    ...s,
    channels: [...s.channels, { kind: "telegram" as const, tokenDigest: "otro" }],
  })],
  ["channels (quitado)", (s) => ({ ...s, channels: [] })],
];

for (const [campo, mutar] of camposDeArranque) {
  test(`agentRuntimeFingerprint: cambiar ${campo} cambia la huella`, () => {
    const antes = baseSnapshot();
    const despues = mutar(baseSnapshot());
    assert.notEqual(agentRuntimeFingerprint(antes), agentRuntimeFingerprint(despues), campo);
  });
}

test("agentRuntimeFingerprint: el telegramToken LEGADO ya no forma parte de la huella", () => {
  // Cutover R3: el token del Runner desapareció del proceso, así que un valor
  // legado en el config no puede mover el arranque de nada. Lo que sí mueve la
  // huella es el canal proyectado (`channels`), que es el dueño real del bot.
  const sinLegado = baseSnapshot();
  const conLegado = { ...baseSnapshot(), telegramToken: "otro-token" };
  assert.equal(agentRuntimeFingerprint(sinLegado), agentRuntimeFingerprint(conLegado));
  assert.equal(agentRuntimeFingerprint(conLegado).includes("otro-token"), false);
});

test("agentRuntimeFingerprint: la rotación del token vive en channels.tokenDigest", () => {
  const antes = { ...baseSnapshot(), telegramToken: "tg-token" };
  const despues = {
    ...baseSnapshot(),
    telegramToken: "tg-token",
    channels: [{ kind: "telegram" as const, tokenDigest: "digest-2" }],
  };
  assert.notEqual(agentRuntimeFingerprint(antes), agentRuntimeFingerprint(despues));
});

// --- canales (channels-and-mcp, slice (c)) ---

test("agentRuntimeFingerprint: cada canal entra como (kind, tokenDigest), nunca como token", () => {
  const huella = agentRuntimeFingerprint({
    ...baseSnapshot(),
    telegramToken: "tg-token",
  });
  const parsed = JSON.parse(huella) as {
    channels: Array<{ kind: string; tokenDigest: string | null }>;
  };
  assert.deepEqual(parsed.channels, [
    { kind: "telegram", tokenDigest: "digest-1" },
  ]);
  // El digest sí viaja; cualquier secreto en claro (el del canal o el legado del
  // Agent) y la etiqueta no.
  assert.equal(huella.includes("digest-1"), true);
  assert.equal(huella.includes("tg-token"), false);
  assert.equal(huella.includes("personal"), false);
});

test("agentRuntimeFingerprint: cambiar solo la etiqueta de un canal NO cambia la huella", () => {
  // La etiqueta no la lee nadie al arrancar: reiniciar por una etiqueta mataría
  // un turno vivo sin ningún efecto observable (runtime-projection: «label
  // changes do NOT trigger restart», tasks (c-T4)).
  const antes = baseSnapshot();
  const despues = {
    ...baseSnapshot(),
    channels: [{ ...baseSnapshot().channels[0], label: "renombrado" }],
  };
  assert.equal(agentRuntimeFingerprint(antes), agentRuntimeFingerprint(despues));
});

test("agentRuntimeFingerprint: channels [] y channels ausente dan la misma huella", () => {
  // I2 del projection: el dashboard manda `[]` al borrar el último canal, y un
  // reconcile sin canales puede omitir el campo. Ambos significan «ninguno».
  const { channels: _omitido, ...sinCampo } = baseSnapshot();
  const vacio = { ...baseSnapshot(), channels: [] };
  assert.equal(agentRuntimeFingerprint(sinCampo), agentRuntimeFingerprint(vacio));
});

test("agentRuntimeFingerprint: el orden de los canales no importa", () => {
  const a = {
    ...baseSnapshot(),
    channels: [
      { kind: "telegram" as const, tokenDigest: "uno" },
      { kind: "telegram" as const, tokenDigest: "dos" },
    ],
  };
  const b = {
    ...baseSnapshot(),
    channels: [
      { kind: "telegram" as const, tokenDigest: "dos" },
      { kind: "telegram" as const, tokenDigest: "uno" },
    ],
  };
  assert.equal(agentRuntimeFingerprint(a), agentRuntimeFingerprint(b));
});

// --- decideRuntimeAction: la tabla de verdad completa ---

test("decideRuntimeAction: enabled:false con el Runner corriendo para el proceso", () => {
  assert.equal(
    decideRuntimeAction({ wasRunning: true, wasEnabled: true, isEnabled: false, fingerprintChanged: false }),
    "stop",
  );
});

test("decideRuntimeAction: enabled:false con el Runner ya parado no hace nada", () => {
  assert.equal(
    decideRuntimeAction({ wasRunning: false, wasEnabled: true, isEnabled: false, fingerprintChanged: false }),
    "none",
  );
});

test("decideRuntimeAction: pasar de deshabilitado a habilitado arranca", () => {
  assert.equal(
    decideRuntimeAction({ wasRunning: false, wasEnabled: false, isEnabled: true, fingerprintChanged: false }),
    "start",
  );
  // Incluso si además cambió la huella: arrancar ya recoge el estado nuevo.
  assert.equal(
    decideRuntimeAction({ wasRunning: false, wasEnabled: false, isEnabled: true, fingerprintChanged: true }),
    "start",
  );
});

test("decideRuntimeAction: un Agent parado y habilitado NO se arranca por sorpresa", () => {
  // Garantía existente: "PATCH de un Agent parado nunca lo arranca"
  // (api-v1-telegram-update.test.ts). Debe seguir así aunque cambie la huella.
  assert.equal(
    decideRuntimeAction({ wasRunning: false, wasEnabled: true, isEnabled: true, fingerprintChanged: true }),
    "none",
  );
  assert.equal(
    decideRuntimeAction({ wasRunning: false, wasEnabled: true, isEnabled: true, fingerprintChanged: false }),
    "none",
  );
});

test("decideRuntimeAction: Runner corriendo y huella sin cambios no hace nada", () => {
  assert.equal(
    decideRuntimeAction({ wasRunning: true, wasEnabled: true, isEnabled: true, fingerprintChanged: false }),
    "none",
  );
});

test("decideRuntimeAction: Runner corriendo y huella distinta reinicia", () => {
  assert.equal(
    decideRuntimeAction({ wasRunning: true, wasEnabled: true, isEnabled: true, fingerprintChanged: true }),
    "restart",
  );
});

// --- projectUpdatedAgent / projectSystemPrompt: el merge SIN escribir a
// disco, para que el PATCH pueda saber si haría falta reiniciar antes de
// persistir (y así poder rechazar con 409 sin dejar el config a medias).
// Debe espejar exactamente el merge real de `updateAgent` en agents.ts.

function baseConfig(): {
  model?: string;
  thinkingLevel?: "medium";
  ttsVoice?: string;
  memory?: { sharedAccess: "read" };
  enabled: boolean;
  telegramToken?: string;
} {
  return {
    model: "anthropic/claude-sonnet-5",
    thinkingLevel: "medium" as const,
    // Campo legado que un `agent.json` anterior al cutover aún puede tener.
    telegramToken: "tg-token",
    ttsVoice: "af_heart",
    memory: { sharedAccess: "read" as const },
    enabled: true,
  };
}
  
test("projectUpdatedAgent: input vacío conserva el config actual sin el token legado", () => {
  const { telegramToken: _legado, ...esperado } = baseConfig();
  assert.deepEqual(projectUpdatedAgent(baseConfig(), {}), esperado);
});

test("projectUpdatedAgent: un campo presente en input lo sobreescribe, el resto queda intacto", () => {
  const proyectado = projectUpdatedAgent(baseConfig(), { model: "openai/gpt-5" });
  assert.equal(proyectado.model, "openai/gpt-5");
  assert.equal(proyectado.thinkingLevel, "medium");
  assert.equal(proyectado.telegramToken, undefined, "el token legado no se proyecta");
});
  
test("projectUpdatedAgent: null explícito limpia ttsVoice/memory; telegramToken se ignora", () => {
  const proyectado = projectUpdatedAgent(baseConfig(), {
    telegramToken: null as unknown as undefined,
    ttsVoice: null,
    memory: null,
  });
  assert.equal(proyectado.telegramToken, undefined);
  assert.equal(proyectado.ttsVoice, undefined);
  assert.equal(proyectado.memory, undefined);
});

test("projectUpdatedAgent: enabled se proyecta igual que cualquier otro campo", () => {
  assert.equal(projectUpdatedAgent(baseConfig(), { enabled: false }).enabled, false);
  assert.equal(projectUpdatedAgent(baseConfig(), {}).enabled, true);
});

test("projectSystemPrompt: sin systemPrompt en el input conserva el actual", () => {
  assert.equal(projectSystemPrompt("Persona actual.", {}), "Persona actual.");
});

test("projectSystemPrompt: con systemPrompt en el input, ese es el proyectado", () => {
  assert.equal(
    projectSystemPrompt("Persona actual.", { systemPrompt: "Persona nueva." }),
    "Persona nueva.",
  );
});

// --- hasLiveTurnForAgent: usada por el PATCH para rechazar con 409
// TURN_IN_PROGRESS un reinicio/parada que mataría un turno en curso.

test("hasLiveTurnForAgent: sin claves registradas da false", () => {
  assert.equal(hasLiveTurnForAgent([], "agent"), false);
});

test("hasLiveTurnForAgent: hay coincidencia exacta de Agent:turnId", () => {
  assert.equal(hasLiveTurnForAgent(["agent:turn-1"], "agent"), true);
});

test("hasLiveTurnForAgent: un turno de OTRO Agent no cuenta", () => {
  assert.equal(hasLiveTurnForAgent(["otro-agent:turn-1"], "agent"), false);
});

test("hasLiveTurnForAgent: un nombre que es prefijo de otro no da falso positivo", () => {
  // "agent-2:turn-1" empieza por "agent" pero NO por "agent:" — el guion
  // rompe el prefijo con dos puntos, así que no debe contar como el mismo Agent.
  assert.equal(hasLiveTurnForAgent(["agent-2:turn-1"], "agent"), false);
});
