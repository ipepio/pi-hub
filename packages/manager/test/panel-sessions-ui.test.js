// T7/3 (S1–S4) — selector de sesiones del panel web.
//
// Qué fija este test, y por qué en este seam: el módulo es la ÚNICA superficie que
// pinta sesiones en el panel, así que se prueba renderizando contra un DOM real
// (jsdom, mismo patrón que `panel-autonomy.test.js`) y leyendo el DOM resultante.
// Reglas observables:
//   * Toda la copy sale del catálogo de labels (S4): aquí se compara contra
//     `SESSIONS_PANEL_LABELS`, nunca contra literales.
//   * El concepto ambiguo (varias sesiones del MISMO Agent, sesión histórica
//     read-only) se explica con un tooltip nativo en un elemento enfocable, porque
//     el panel no tiene componente de tooltip.
//   * Una fecha desconocida se dice, no se inventa: la entrada legacy se adoptó con
//     epoch 0 y eso no es una fecha que se pueda enseñar (S7).
//   * La key del Runner NO se pinta NUNCA (vive en el payload, es interior).
//   * Confirmaciones en `role="status"` y errores en `role="alert"`.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createSessionsPanel } from "../public/panel-sessions-ui.js";
import { SESSIONS_PANEL_LABELS } from "../public/panel-labels.js";

/** Centinela: si aparece en el DOM, el panel está filtrando la key del Runner. */
const KEY_SENTINEL = "agent:linus:session:NUNCA-VISIBLE";

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><div id="sessions"></div>', { url: "http://localhost" });
  const { document } = dom.window;
  return { document, container: document.getElementById("sessions") };
}

function session(overrides = {}) {
  return {
    id: "s-1",
    key: KEY_SENTINEL,
    channel: "web",
    agent: "linus",
    name: "Charla",
    legacy: false,
    createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

const NAMED = session();
const LEGACY = session({
  id: "main",
  key: "agent:linus:main",
  channel: "telegram",
  name: null,
  legacy: true,
  createdAt: "1970-01-01T00:00:00.000Z",
});

function catalogue(overrides = {}) {
  return {
    agent: "linus",
    sessions: [NAMED, LEGACY],
    selection: { web: NAMED.id, telegram: LEGACY.id },
    ...overrides,
  };
}

/**
 * Catálogo falso con estado: `select` mueve el puntero web y `list` lo refleja, que
 * es justo la propiedad que el panel necesita para no mentir después de actuar.
 */
function fakePanelSessions({ failList = false, failSelect = false } = {}) {
  const calls = [];
  const state = { sessions: [NAMED, LEGACY], selection: { web: NAMED.id, telegram: LEGACY.id } };
  const api = {
    async list(agent) {
      calls.push(["list", agent]);
      if (failList) throw new Error("catálogo roto");
      return { agent, sessions: state.sessions.map((item) => ({ ...item })), selection: { ...state.selection } };
    },
    async create(agent, options = {}) {
      calls.push(["create", agent, options]);
      const created = session({
        id: "s-2",
        key: "agent:linus:session:NUNCA-VISIBLE-2",
        name: options.name ?? null,
        legacy: false,
        createdAt: "2026-10-02T09:00:00.000Z",
      });
      state.sessions = [...state.sessions, created];
      return { ...created };
    },
    async select(agent, sessionId, channel = "web") {
      calls.push(["select", agent, sessionId, channel]);
      if (failSelect) throw new Error("no se pudo seleccionar");
      state.selection[channel] = sessionId;
      const found = state.sessions.find((item) => item.id === sessionId);
      return { agent, channel, session: { ...found } };
    },
  };
  api.calls = calls;
  api.state = state;
  return api;
}

/** Compara copy contra su label sin construir regex (los labels llevan paréntesis). */
function assertHasCopy(text, label) {
  assert.ok(text.includes(label), `se esperaba la copy "${label}" en "${text}"`);
}

function newPanel({ calls } = {}) {
  const { document, container } = setup();
  const panelSessions = calls || fakePanelSessions();
  const selected = [];
  const panel = createSessionsPanel({
    container,
    panelSessions,
    onSessionSelected: (chosen, info) => selected.push({ chosen, info }),
  });
  return { document, container, panelSessions, panel, selected };
}

const rows = (container) => [...container.querySelectorAll("li[data-session-id]")];
const statusText = (container) => container.querySelector('[role="status"]').textContent;
const alertText = (container) => container.querySelector('[role="alert"]').textContent;
const tooltipOf = (container, name) => container.querySelector(`[aria-label="${name}"]`);

test("T7/3 UI: encabezado y tooltip nativo enfocable salen del catálogo", () => {
  const { container, panel } = newPanel();

  panel.render({ sessions: catalogue().sessions, selection: catalogue().selection, loading: false });

  assertHasCopy(container.textContent, SESSIONS_PANEL_LABELS.sessionsHeading);
  const tooltip = container.querySelector(`[title="${SESSIONS_PANEL_LABELS.sessionsTooltip}"]`);
  assert.ok(tooltip, "el tooltip es el atributo title del disparador");
  assert.equal(tooltip.getAttribute("tabindex"), "0", "el disparador del tooltip es enfocable");
  assert.equal(tooltip.getAttribute("aria-label"), SESSIONS_PANEL_LABELS.sessionsTooltipLabel);
  assert.ok(tooltipOf(container, SESSIONS_PANEL_LABELS.sessionsTooltipLabel));
});

test("T7/3 UI: cada fila pinta nombre, fecha, marcas y estado sin la key", () => {
  const { container, panel } = newPanel();

  panel.render({ sessions: catalogue().sessions, selection: catalogue().selection });

  const [named, legacy] = rows(container);
  assert.ok(named, "una fila por sesión");
  assert.match(named.textContent, /Charla/);
  assert.match(named.textContent, /01\/10\/2026/, "fecha honesta de la sesión nueva");
  assertHasCopy(named.textContent, SESSIONS_PANEL_LABELS.sessionSelectedWeb);
  assertHasCopy(legacy.textContent, SESSIONS_PANEL_LABELS.sessionUnnamed);
  assertHasCopy(legacy.textContent, SESSIONS_PANEL_LABELS.sessionLegacy);
  assertHasCopy(legacy.textContent, SESSIONS_PANEL_LABELS.sessionUnknownDate);
  assertHasCopy(legacy.textContent, SESSIONS_PANEL_LABELS.sessionTelegramMark);
  assert.equal(
    legacy.querySelector(`[title="${SESSIONS_PANEL_LABELS.sessionLegacyTooltip}"]`)?.getAttribute("tabindex"),
    "0",
    "el tooltip de legacy también se puede enfocar",
  );

  assert.equal(named.getAttribute("data-session-id"), NAMED.id);
  assert.equal(legacy.getAttribute("data-session-id"), LEGACY.id);
  assert.ok(!container.innerHTML.includes(KEY_SENTINEL), "la key del Runner no se pinta");
  assert.ok(!container.innerHTML.includes("agent:linus:main"), "ni siquiera la de la sesión legacy");
});

test("T7/3 UI: el botón de seleccionar se deshabilita solo en la fila ya seleccionada", () => {
  const { container, panel } = newPanel();

  panel.render({ sessions: catalogue().sessions, selection: catalogue().selection });

  const [named, legacy] = rows(container);
  const namedButton = named.querySelector("button[data-action='select']");
  const legacyButton = legacy.querySelector("button[data-action='select']");
  assert.equal(namedButton.textContent, SESSIONS_PANEL_LABELS.sessionSelectAction);
  assert.equal(namedButton.disabled, true);
  assert.equal(legacyButton.disabled, false);
  assert.equal(
    legacyButton.getAttribute("aria-label"),
    SESSIONS_PANEL_LABELS.sessionSelectActionFor.replace("{name}", SESSIONS_PANEL_LABELS.sessionUnnamed),
  );
});

test("T7/3 UI: load pinta el catálogo y publica la sesión web seleccionada al panel", async () => {
  const { container, panel, selected } = newPanel();

  panel.open("linus");
  await panel.load();

  assert.equal(rows(container).length, 2);
  const last = selected.at(-1);
  assert.equal(last.info.status, "ready");
  assert.equal(last.chosen.id, NAMED.id);
  assert.equal(last.chosen.key, KEY_SENTINEL, "el panel recibe la key para el turno; el DOM no la pinta");
  assert.ok(!container.innerHTML.includes(KEY_SENTINEL));
});

test("T7/3 UI: sin selección web se dice, y el panel no adopta ninguna sesión", async () => {
  const { container } = setup();
  const selected = [];
  const panel = createSessionsPanel({
    container,
    panelSessions: {
      list: async () => ({ agent: "linus", sessions: [NAMED], selection: { web: null, telegram: null } }),
    },
    onSessionSelected: (chosen, info) => selected.push({ chosen, info }),
  });

  panel.open("linus");
  await panel.load();

  assert.equal(selected.at(-1).chosen, null);
  assert.equal(selected.at(-1).info.status, "ready", "el catálogo cargó: falta una selección explícita");
  assert.equal(rows(container).length, 1);
});

test("T7/3 UI: estado de carga y estado vacío usan su label", async () => {
  const { container, panel } = newPanel();

  panel.open("linus");
  assertHasCopy(statusText(container), SESSIONS_PANEL_LABELS.sessionsLoading);

  panel.render({ sessions: [], selection: { web: null, telegram: null }, loading: false });
  assert.equal(rows(container).length, 0);
  assertHasCopy(statusText(container), SESSIONS_PANEL_LABELS.sessionsEmpty);
});

test("T7/3 UI: si el catálogo falla se pinta el error y NO se adopta ninguna sesión", async () => {
  const { container, selected } = newPanel();
  const panelSessions = fakePanelSessions({ failList: true });
  const panel = createSessionsPanel({
    container,
    panelSessions,
    onSessionSelected: (chosen, info) => selected.push({ chosen, info }),
  });

  panel.open("linus");
  await panel.load();

  assertHasCopy(alertText(container), SESSIONS_PANEL_LABELS.sessionsLoadError);
  assert.equal(rows(container).length, 0);
  assert.equal(selected.at(-1).chosen, null);
  assert.equal(selected.at(-1).info.status, "error", "fallo cerrado: el panel no puede enviar turnos");
  assert.ok(container.querySelector("button[data-action='retry']"), "se ofrece reintentar");
});

test("T7/3 UI: el formulario crea y luego selecciona en web, con confirmación en status", async () => {
  const { document, container, panel, panelSessions, selected } = newPanel();

  panel.open("linus");
  await panel.load();

  const form = container.querySelector("form[data-form='create']");
  const input = form.querySelector("input");
  assert.equal(input.getAttribute("placeholder"), SESSIONS_PANEL_LABELS.sessionNamePlaceholder);
  input.value = "Nueva";
  form.dispatchEvent(new document.defaultView.Event("submit"));

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    panelSessions.calls.filter(([name]) => name === "create" || name === "select"),
    [
      ["create", "linus", { name: "Nueva" }],
      ["select", "linus", "s-2", "web"],
    ],
  );
  assertHasCopy(statusText(container), SESSIONS_PANEL_LABELS.sessionCreatedConfirmation);
  assert.equal(selected.at(-1).chosen.id, "s-2");
  assert.equal(rows(container).length, 3, "la lista se relee: la sesión nueva ya está");
});

test("T7/3 UI: seleccionar una fila mueve la web y confirma en status", async () => {
  const { document, container, panel, panelSessions, selected } = newPanel();

  panel.open("linus");
  await panel.load();

  const legacyRow = rows(container).find((row) => row.getAttribute("data-session-id") === LEGACY.id);
  legacyRow.querySelector("button[data-action='select']").dispatchEvent(
    new document.defaultView.Event("click"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    panelSessions.calls.filter(([name]) => name === "select"),
    [["select", "linus", LEGACY.id, "web"]],
  );
  assertHasCopy(statusText(container), SESSIONS_PANEL_LABELS.sessionSelectedConfirmation);
  assert.equal(selected.at(-1).chosen.id, LEGACY.id);
});

test("T7/3 UI: si seleccionar falla se avisa en la región de alerta y se relee el catálogo", async () => {
  const { document, container, selected } = newPanel();
  const panelSessions = fakePanelSessions({ failSelect: true });
  const panel = createSessionsPanel({
    container,
    panelSessions,
    onSessionSelected: (chosen, info) => selected.push({ chosen, info }),
  });

  panel.open("linus");
  await panel.load();

  const legacyRow = rows(container).find((row) => row.getAttribute("data-session-id") === LEGACY.id);
  legacyRow.querySelector("button[data-action='select']").dispatchEvent(
    new document.defaultView.Event("click"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertHasCopy(alertText(container), SESSIONS_PANEL_LABELS.sessionActionError);
  assert.equal(selected.at(-1).chosen.id, NAMED.id, "la selección vigente no cambia si la acción falla");
});

test("T7/3 UI: setBusy deshabilita acciones mientras hay una operación en vuelo", async () => {
  const { container, panel } = newPanel();

  panel.open("linus");
  await panel.load();

  panel.setBusy(true);
  for (const button of container.querySelectorAll("button")) {
    assert.equal(button.disabled, true, "ninguna acción queda disponible en vuelo");
  }

  panel.setBusy(false);
  const legacyRow = rows(container).find((row) => row.getAttribute("data-session-id") === LEGACY.id);
  assert.equal(legacyRow.querySelector("button[data-action='select']").disabled, false);
});

test("T7/3 UI: una respuesta tardía de otro Agent no se adopta", async () => {
  const { container } = setup();
  const selected = [];
  let resolveList;
  const panel = createSessionsPanel({
    container,
    panelSessions: { list: () => new Promise((resolve) => { resolveList = resolve; }) },
    onSessionSelected: (chosen, info) => selected.push({ chosen, info }),
  });

  panel.open("alice");
  const pending = panel.load();
  panel.open("bob");
  resolveList({ agent: "alice", sessions: [NAMED], selection: { web: NAMED.id, telegram: null } });
  await pending;

  assert.deepEqual(selected, [], "la sesión de alice no se adopta para bob");
  assert.equal(rows(container).length, 0);
});

test("T7/3 UI: un fallo posterior del catálogo retira la confirmación anterior", async () => {
  const { container } = setup();
  let listCalls = 0;
  const panel = createSessionsPanel({
    container,
    panelSessions: {
      async list() {
        listCalls += 1;
        if (listCalls >= 3) throw new Error("catálogo caído");
        return { agent: "linus", sessions: [NAMED], selection: { web: NAMED.id, telegram: null } };
      },
      create: async () => ({ ...NAMED, id: "s-2", name: "Nueva" }),
      select: async () => ({ agent: "linus", channel: "web", session: NAMED }),
    },
    onSessionSelected: () => {},
  });

  panel.open("linus");
  await panel.load();
  await panel.createSession("Nueva");
  assertHasCopy(statusText(container), SESSIONS_PANEL_LABELS.sessionCreatedConfirmation);

  await panel.load();

  assert.equal(statusText(container), "", "no se queda la confirmación de una acción anterior");
  assertHasCopy(alertText(container), SESSIONS_PANEL_LABELS.sessionsLoadError);
});

test("T7/3 UI: createSession es la entrada del comando /new y devuelve la sesión adoptada", async () => {
  const { panel, panelSessions } = newPanel();

  panel.open("linus");
  await panel.load();

  const created = await panel.createSession("Desde /new");

  assert.equal(created.id, "s-2");
  assert.deepEqual(
    panelSessions.calls.filter(([name]) => name === "create" || name === "select"),
    [
      ["create", "linus", { name: "Desde /new" }],
      ["select", "linus", "s-2", "web"],
    ],
  );
});
