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
  return {
    model: "anthropic/claude-sonnet-5",
    thinkingLevel: "medium" as const,
    telegramToken: "tg-token",
    ttsVoice: "af_heart",
    memory: { sharedAccess: "read" as const },
    systemPrompt: "Eres un asistente.",
    env: { FOO: "bar" },
    packages: ["npm:@scope/skill"],
  };
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
  ["telegramToken", (s) => ({ ...s, telegramToken: "otro-token" })],
  ["ttsVoice", (s) => ({ ...s, ttsVoice: "otra-voz" })],
  ["memory.sharedAccess", (s) => ({ ...s, memory: { sharedAccess: "none" } })],
  ["systemPrompt", (s) => ({ ...s, systemPrompt: "Otra persona." })],
  ["env (valor)", (s) => ({ ...s, env: { FOO: "otro-valor" } })],
  ["env (clave nueva)", (s) => ({ ...s, env: { ...s.env, NUEVA: "x" } })],
  ["env (clave quitada)", (s) => ({ ...s, env: {} })],
  ["packages (añadido)", (s) => ({ ...s, packages: [...s.packages, "npm:@scope/otro"] })],
  ["packages (quitado)", (s) => ({ ...s, packages: [] })],
];

for (const [campo, mutar] of camposDeArranque) {
  test(`agentRuntimeFingerprint: cambiar ${campo} cambia la huella`, () => {
    const antes = baseSnapshot();
    const despues = mutar(baseSnapshot());
    assert.notEqual(agentRuntimeFingerprint(antes), agentRuntimeFingerprint(despues), campo);
  });
}

test("agentRuntimeFingerprint: telegramToken ausente vs undefined explícito dan la misma huella", () => {
  const { telegramToken: _omitido, ...sinToken } = baseSnapshot();
  const conUndefined = { ...baseSnapshot(), telegramToken: undefined };
  assert.equal(agentRuntimeFingerprint(sinToken), agentRuntimeFingerprint(conUndefined));
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

function baseConfig() {
  return {
    model: "anthropic/claude-sonnet-5",
    thinkingLevel: "medium" as const,
    telegramToken: "tg-token",
    ttsVoice: "af_heart",
    memory: { sharedAccess: "read" as const },
    enabled: true,
  };
}

test("projectUpdatedAgent: input vacío conserva el config actual tal cual", () => {
  assert.deepEqual(projectUpdatedAgent(baseConfig(), {}), baseConfig());
});

test("projectUpdatedAgent: un campo presente en input lo sobreescribe, el resto queda intacto", () => {
  const proyectado = projectUpdatedAgent(baseConfig(), { model: "openai/gpt-5" });
  assert.equal(proyectado.model, "openai/gpt-5");
  assert.equal(proyectado.thinkingLevel, "medium");
  assert.equal(proyectado.telegramToken, "tg-token");
});

test("projectUpdatedAgent: null explícito limpia telegramToken/ttsVoice/memory", () => {
  const proyectado = projectUpdatedAgent(baseConfig(), {
    telegramToken: null,
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
