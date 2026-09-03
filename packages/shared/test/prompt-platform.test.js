import test from "node:test";
import assert from "node:assert/strict";
import { buildPlatformPrompt } from "../dist/prompt.js";

const base = { agentName: "asistente", memoryEnabled: true, telegram: false };

test("sección Autonomía existe y menciona Agenda y las tools de Trigger", () => {
  const section = buildPlatformPrompt({ ...base, sessionType: "initiative" });
  assert.match(section, /# Autonomía y Agenda/);
  assert.match(section, /Agenda/);
  assert.match(section, /`schedule_trigger`/);
  assert.match(section, /`revoke_trigger`/);
});

test("prohíbe sugerir schedulers de nivel de sistema (crontab/schtasks/systemd)", () => {
  const section = buildPlatformPrompt({ ...base, sessionType: "initiative" });
  assert.match(section, /No sugieras programadores de nivel de sistema/);
  assert.match(section, /crontab/);
  assert.match(section, /schtasks/);
  assert.match(section, /systemd/);
});

test("iniative: dice que las tools están disponibles en ESTA sesión", () => {
  const section = buildPlatformPrompt({ ...base, sessionType: "initiative" });
  assert.match(
    section,
    /En esta sesión sí puedes crearlos tú mismo con `schedule_trigger`/,
  );
  assert.match(section, /preguntar al usuario con `ask_human`/);
});

test("human: no anuncia las tools como disponibles, pero ofrece configurar un Trigger", () => {
  const section = buildPlatformPrompt({ ...base, sessionType: "human" });
  assert.doesNotMatch(section, /En esta sesión sí puedes crearlos tú mismo/);
  assert.match(
    section,
    /no tienes las tools `schedule_trigger`\/`revoke_trigger`/,
  );
  assert.match(section, /ofrecerte a programarlo/);
});

test("advierte sobre capacidades faltantes en lugar de fingir que la tarea se ejecuta", () => {
  const section = buildPlatformPrompt({ ...base, sessionType: "initiative" });
  assert.match(section, /capacidad o credencial que falta/);
  assert.match(section, /Nunca finjas que la tarea se ejecuta/);
});
