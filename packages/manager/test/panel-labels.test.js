// T7/3 (S4) — catálogo de copy del panel de sesiones.
//
// S4 exige que TODO el texto visible de la UI nueva o tocada sea un label y nunca
// un literal escondido en el componente. Este test fija las dos mitades de esa
// regla: (1) las claves que la UI necesita existen y tienen texto, y (2) la
// interpolación tiene la MISMA regla que `src/channels/labels.ts`: solo `{nombre}`
// se sustituye y un token sin valor se conserva verbatim, para que un olvido se
// vea en el texto en vez de imprimir `undefined`.

import test from "node:test";
import assert from "node:assert/strict";
import { SESSIONS_PANEL_LABELS, formatLabel } from "../public/panel-labels.js";

/** Claves que el panel de sesiones consume (contrato de T7/3). */
const REQUIRED_KEYS = [
  "sessionsHeading",
  "sessionsTooltip",
  "sessionUnnamed",
  "sessionLegacy",
  "sessionLegacyTooltip",
  "sessionUnknownDate",
  "sessionSelectedWeb",
  "sessionSelectAction",
  "sessionCreateAction",
  "sessionNamePlaceholder",
  "sessionsEmpty",
  "sessionsLoading",
  "sessionsLoadError",
  "sessionCreatedConfirmation",
  "sessionSelectedConfirmation",
  "sessionActionError",
  "sessionRequiredForTurn",
  "sessionTelegramMark",
];

test("T7/3 labels: todas las claves del panel existen y no están vacías", () => {
  for (const key of REQUIRED_KEYS) {
    const value = SESSIONS_PANEL_LABELS[key];
    assert.equal(typeof value, "string", `falta la label ${key}`);
    assert.ok(value.trim().length > 0, `la label ${key} está vacía`);
  }
});

test("T7/3 labels: el tooltip de legacy nombra el ADR 0107 y la lectura única", () => {
  const tooltip = SESSIONS_PANEL_LABELS.sessionLegacyTooltip;
  assert.match(tooltip, /ADR 0107/);
  assert.match(tooltip, /leer/);
});

test("T7/3 labels: formatLabel sustituye placeholders con nombre", () => {
  assert.equal(formatLabel("Seleccionar {name}", { name: "Charla" }), "Seleccionar Charla");
  assert.equal(
    formatLabel("{a}-{b}-{a}", { a: "x", b: "y" }),
    "x-y-x",
    "un mismo placeholder se sustituye en todas sus apariciones",
  );
});

test("T7/3 labels: formatLabel conserva verbatim un token desconocido o sin valor", () => {
  assert.equal(formatLabel("Hola {nombre}", {}), "Hola {nombre}");
  assert.equal(formatLabel("Hola {nombre}", { otro: "x" }), "Hola {nombre}");
  assert.equal(formatLabel("Hola {nombre}", { nombre: "" }), "Hola ");
  assert.equal(formatLabel("sin tokens", { nombre: "x" }), "sin tokens");
});

test("T7/3 labels: formatLabel no inventa valores y no re-interpola el resultado", () => {
  assert.equal(formatLabel("{a}", { a: "{b}", b: "x" }), "{b}");
});
