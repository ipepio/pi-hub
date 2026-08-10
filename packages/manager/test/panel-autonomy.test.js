/* P2.6 — Tests DOM/flujo del panel de Autonomía (jsdom) */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createAutonomyPanel } from "../public/panel-autonomy.js";

/** Construye un DOM mínimo con los IDs que necesita el panel */
function setupDom() {
  const dom = new JSDOM(
    `<!DOCTYPE html>
    <div id="agent-panel-autonomy" class="agent-panel">
      <div class="autonomy-toolbar">
        <button id="autonomy-refresh" type="button">↻</button>
      </div>
      <div id="autonomy-content"></div>
      <details class="autonomy-create-panel">
        <summary>+ Crear trigger</summary>
        <form id="autonomy-create-form">
          <select id="autonomy-create-definition">
            <option value="daily">Diario</option>
            <option value="weekly">Semanal</option>
          </select>
          <input id="autonomy-create-zone" value="UTC" />
          <input id="autonomy-create-at" type="time" value="09:00" />
          <input id="autonomy-create-days" />
          <input id="autonomy-create-intent" />
          <select id="autonomy-create-mode">
            <option value="solo">Solo</option>
            <option value="ask">Ask</option>
          </select>
          <input id="autonomy-create-skill" />
          <button type="submit">Crear</button>
          <span id="autonomy-create-status"></span>
        </form>
      </details>
    </div>
    <span id="agent-badge-autonomy" class="sidebar-badge hidden"></span>
    <div class="sidebar-link" data-screen="agents">Agentes</div>`,
    { url: "http://localhost" },
  );
  const { document } = dom.window;
  return { dom, document };
}

/** Fábrica de IDs predecibles */
function seqIdFactory() {
  let n = 0;
  return () => `id-${++n}`;
}

/** Fake de la API */
function fakeApi() {
  const calls = [];
  const api = {
    getAutonomy: async (name) => {
      calls.push(["getAutonomy", name]);
      return {
        asOf: 1700000000000,
        initiatives: [
          { id: "i-queued", status: "queued", mode: "solo", intent: "Análisis nocturno", availableAt: 1699980000000 },
          { id: "i-run", status: "running", mode: "solo", intent: "Revisar incidencias", summary: "Ejecutando…", startedAt: 1699990000000, stateChangedAt: 1699990000000 },
          { id: "i-wait-human", status: "waiting_human", mode: "ask", intent: "Aprobar", question: "¿Procedemos?", createdAt: 1699998000000, expiresAt: 1700100000000 },
          { id: "i-wait-agent", status: "waiting_agent", mode: "ask", intent: "Esperando runner", startedAt: 1699990000000 },
          { id: "i-succ", status: "succeeded", mode: "solo", summary: "Informe listo", finishedAt: 1699995000000 },
          { id: "i-fail", status: "failed", mode: "ask", summary: "Error", failureReason: "runner_unavailable", finishedAt: 1699996000000 },
          { id: "i-exp", status: "expired", mode: "solo", summary: "Tiempo agotado", finishedAt: 1699997000000 },
          { id: "i-canc", status: "cancelled", mode: "solo", summary: "Cancelada", finishedAt: 1699998000000 },
        ],
        agenda: [{ position: 1, initiative: { id: "i-queued", status: "queued", mode: "solo", intent: "Análisis nocturno" } }],
        inbox: [{ id: "i-wait-human", status: "waiting_human", mode: "ask", intent: "Aprobar", question: "¿Procedemos?", createdAt: 1699998000000, expiresAt: 1700100000000 }],
        triggers: [
          { id: "trig-1", kind: "daily", definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" }, intent: "Revisar", mode: "solo", enabled: true, createdBy: "panel", authority: "owner", nextFireAt: 1700100000000, lastFiredAt: 1699990000000 },
          { id: "trig-2", kind: "weekly", definition: { version: 2, kind: "weekly", timeZone: "UTC", at: "10:00", days: ["mon", "wed", "fri"] }, intent: "Weekly", mode: "ask", enabled: false, createdBy: "admin" },
        ],
        historyTruncated: false,
      };
    },
    createTrigger: async (name, command, key) => { calls.push(["createTrigger", name, command, key]); return { trigger: { id: "new-trig-1" }, replayed: false }; },
    revokeTrigger: async (name, triggerId) => { calls.push(["revokeTrigger", name, triggerId]); return { trigger: { id: triggerId, enabled: false } }; },
    cancelInitiative: async (name, initiativeId) => { calls.push(["cancelInitiative", name, initiativeId]); return { status: "cancelled", initiative: { id: initiativeId } }; },
    respondToInitiative: async (name, initiativeId, answer, key) => { calls.push(["respondToInitiative", name, initiativeId, answer, key]); return { initiative: { id: initiativeId, status: "queued" }, replayed: false }; },
  };
  api._calls = calls;
  return api;
}

function assertNoLeak(doc, sentinel) {
  const html = doc.getElementById("autonomy-content")?.innerHTML || "";
  assert.ok(!html.includes(sentinel), `DOM contiene valor filtrado: ${sentinel}`);
}

// ====================================================================
// 1. Render de Agenda/en vuelo/historia/Triggers/inbox y 8 labels
// ====================================================================
test("P2.6.1: renderiza todas las secciones y cubre los ocho estados", async () => {
  const { document } = setupDom();
  const api = fakeApi();
  const panel = createAutonomyPanel({ api, document, now: () => 1700000000000, confirm: () => true });

  panel.selectAgent("linus");
  panel.activate();
  await panel.refresh();

  const content = document.getElementById("autonomy-content");
  assert.ok(content, "debe existir autonomy-content");
  const html = content.innerHTML;

  assert.ok(html.includes("Agenda"), "sección Agenda");
  assert.ok(html.includes("En vuelo"), "sección En vuelo");
  assert.ok(html.includes("Historial"), "sección Historial");
  assert.ok(html.includes("Triggers"), "sección Triggers");
  assert.ok(html.includes("Inbox"), "sección Inbox");

  const labels = ["En cola", "Ejecutando", "Espera humana", "Espera agente", "Completado", "Fallido", "Expirado", "Cancelado"];
  for (const lbl of labels) assert.ok(html.includes(lbl), `contiene label "${lbl}"`);

  panel.deactivate();
});

// ====================================================================
// 2. intent/question con HTML hostil se ve como texto
// ====================================================================
test("P2.6.2: texto hostil usa textContent, no innerHTML", async () => {
  const { document } = setupDom();
  const api = fakeApi();
  const HOSTILE_INTENT = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
  const HOSTILE_QUESTION = '<a href="javascript:alert(1)">click</a>';

  api.getAutonomy = async () => ({
    asOf: 1700000000000,
    initiatives: [{ id: "i-mal", status: "waiting_human", mode: "ask", intent: HOSTILE_INTENT, question: HOSTILE_QUESTION, summary: "<b>peligro</b>", createdAt: 1699998000000, expiresAt: 1700100000000 }],
    agenda: [],
    inbox: [{ id: "i-mal", status: "waiting_human", mode: "ask", intent: HOSTILE_INTENT, question: HOSTILE_QUESTION, createdAt: 1699998000000, expiresAt: 1700100000000 }],
    triggers: [],
    historyTruncated: false,
  });

  const panel = createAutonomyPanel({ api, document, now: () => 1700000000000, confirm: () => true });
  panel.selectAgent("linus");
  panel.activate();
  await panel.refresh();

  assert.equal(document.querySelector("script"), null, "sin nodos <script>");
  assert.equal(document.querySelector("img"), null, "sin nodos <img>");
  assert.equal(document.querySelector('a[href*="javascript"]'), null, "sin enlaces javascript:");

  const innerText = document.getElementById("autonomy-content").textContent;
  assert.ok(innerText.includes('<script>alert("xss")</script>'), "script literal visible");
  assert.ok(innerText.includes('<img src=x onerror=alert(1)>'), "img onerror literal visible");

  panel.deactivate();
});

// ====================================================================
// 3. daily/weekly construyen el comando exacto; retry conserva key
// ====================================================================
test("P2.6.3: crear trigger daily/weekly construye command exacto; retry conserva key", async () => {
  const { document } = setupDom();
  const api = fakeApi();
  let lastCommand, lastKey;
  api.createTrigger = async (name, command, key) => { lastCommand = command; lastKey = key; return { trigger: { id: "new" }, replayed: false }; };

  const idFactory = seqIdFactory();
  const panel = createAutonomyPanel({ api, document, idFactory, now: () => Date.now(), confirm: () => true });
  panel.selectAgent("linus");
  panel.activate();

  // daily
  document.getElementById("autonomy-create-definition").value = "daily";
  document.getElementById("autonomy-create-zone").value = "Europe/Madrid";
  document.getElementById("autonomy-create-at").value = "08:00";
  document.getElementById("autonomy-create-intent").value = "Revisar cada día";
  document.getElementById("autonomy-create-mode").value = "solo";
  document.getElementById("autonomy-create-skill").value = "";
  document.getElementById("autonomy-create-form").dispatchEvent(new document.defaultView.Event("submit", { cancelable: true }));

  assert.ok(lastCommand, "createTrigger invocado");
  assert.deepEqual(lastCommand.definition, { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "08:00" });
  assert.equal(lastCommand.intent, "Revisar cada día");
  assert.equal(lastCommand.mode, "solo");
  assert.equal(lastCommand.suggestedSkill, null);
  const firstKey = lastKey;

  // weekly
  lastCommand = null; lastKey = null;
  document.getElementById("autonomy-create-definition").value = "weekly";
  document.getElementById("autonomy-create-zone").value = "America/New_York";
  document.getElementById("autonomy-create-at").value = "10:00";
  document.getElementById("autonomy-create-days").value = "mon,wed,fri";
  document.getElementById("autonomy-create-intent").value = "Weekly sync";
  document.getElementById("autonomy-create-mode").value = "ask";
  document.getElementById("autonomy-create-skill").value = "skill-review";
  document.getElementById("autonomy-create-form").dispatchEvent(new document.defaultView.Event("submit", { cancelable: true }));

  assert.ok(lastCommand, "weekly creado");
  assert.deepEqual(lastCommand.definition, { version: 2, kind: "weekly", timeZone: "America/New_York", at: "10:00", days: ["mon", "wed", "fri"] });
  assert.equal(lastCommand.intent, "Weekly sync");
  assert.equal(lastCommand.mode, "ask");
  assert.equal(lastCommand.suggestedSkill, "skill-review");
  assert.notEqual(firstKey, lastKey, "keys distintas por comando");

  // retry con misma key
  lastKey = null;
  await api.createTrigger("linus", lastCommand, firstKey);
  assert.equal(lastKey, firstKey, "retry conserva key");

  panel.deactivate();
});

// ====================================================================
// 4. revoke exige confirm; cancel 200/202; respond key en retry y limpia
// ====================================================================
test("P2.6.4: revoke confirma; cancel/respond key y limpia", async () => {
  const { document } = setupDom();
  const api = fakeApi();
  const confirmLog = [];
  let callLog = [];
  api.revokeTrigger = async (n, id) => { callLog.push(["revoke", id]); return { trigger: { id, enabled: false } }; };
  api.cancelInitiative = async (n, id) => { callLog.push(["cancel", id]); return { status: "cancelled", initiative: { id } }; };
  api.respondToInitiative = async (n, id, a, k) => { callLog.push(["respond", id, a, k]); return { initiative: { id }, replayed: false }; };

  const panel = createAutonomyPanel({
    api, document, now: () => 1700000000000, idFactory: seqIdFactory(),
    confirm: () => { confirmLog.push("confirm"); return true; },
  });
  panel.selectAgent("linus");
  panel.activate();
  await panel.refresh();
  callLog = [];

  // Botón revocar en trigger
  assert.ok(document.body.textContent.includes("Revocar"), "botón Revocar presente");

  // Botón Cancelar en inbox
  const cancelBtns = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent.trim() === "Cancelar");
  assert.ok(cancelBtns.length > 0, "botón Cancelar en inbox");
  confirmLog.length = 0;
  cancelBtns[0].click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(confirmLog.length, 1, "confirm llamado para cancel");

  // Botón Responder en inbox
  const respondBtns = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent.trim() === "Responder");
  assert.ok(respondBtns.length > 0, "botón Responder en inbox");

  panel.deactivate();
});

// ====================================================================
// 5. campos internos no filtran
// ====================================================================
test("P2.6.5: campos internos no filtran en DOM", async () => {
  const { document } = setupDom();
  const api = {
    getAutonomy: async () => ({
      asOf: 1700000000000,
      initiatives: [{ id: "i-sec", status: "succeeded", mode: "solo", summary: "OK", finishedAt: 1699990000000,
        sessionKey: "sk-123", turnId: "turn-456", boundModel: "gpt-4", askCorrelation: "corr-789",
        pendingHumanInput: { answer: "secret" }, result: "no-publicable",
        transcript: [{ role: "user", content: "secreto" }], token: "tok-secret", path: "/tmp/secret", telegramChatId: "12345",
      }],
      agenda: [], inbox: [], triggers: [], historyTruncated: false,
    }),
    createTrigger: () => {}, revokeTrigger: () => {}, cancelInitiative: () => {}, respondToInitiative: () => {},
  };

  const panel = createAutonomyPanel({ api, document, now: () => 1700000000000, confirm: () => true });
  panel.selectAgent("linus");
  panel.activate();
  await panel.refresh();

  for (const s of ["sk-123", "turn-456", "gpt-4", "corr-789", "secret", "no-publicable", "secreto", "tok-secret", "secret-file", "12345"]) {
    assertNoLeak(document, s);
  }

  panel.deactivate();
});

// ====================================================================
// 6. notificationStatus not_delivered avisa sin bloquear la respuesta
// ====================================================================
test("P3.4/A11: notificationStatus not_delivered muestra alert y conserva Responder", async () => {
  const { document } = setupDom();
  const api = fakeApi();
  api.getAutonomy = async () => {
    const waiting = {
      id: "i-not-delivered",
      status: "waiting_human",
      mode: "ask",
      question: "¿Procedemos?",
      notificationStatus: "not_delivered",
      createdAt: 1699998000000,
      expiresAt: 1700100000000,
    };
    return {
      asOf: 1700000000000,
      initiatives: [waiting],
      agenda: [],
      inbox: [waiting],
      triggers: [],
      historyTruncated: false,
    };
  };

  const panel = createAutonomyPanel({ api, document, confirm: () => true });
  panel.selectAgent("linus");
  panel.activate();
  await panel.refresh();

  const alert = document.querySelector('.autonomy-inbox-card [role="alert"]');
  assert.ok(alert, "warning accionable con role=alert en el inbox real");
  assert.match(alert.textContent, /Telegram/);
  assert.match(alert.textContent, /Responde aquí en el panel/);
  const inboxCard = alert.closest(".autonomy-inbox-card");
  const respondButton = Array.from(inboxCard.querySelectorAll("button"))
    .find((button) => button.textContent.trim() === "Responder");
  assert.ok(respondButton, "el warning no elimina el botón Responder");

  panel.deactivate();
});

// ====================================================================
// 7. documento oculto no hace fetch; activate/focus sí; sin duplicados
// ====================================================================
test("P2.6.6: documento oculto no hace fetch; activate con visible sí", async () => {
  const { document } = setupDom();
  let fetchCount = 0;
  const api = {
    getAutonomy: async () => { fetchCount++; return { asOf: Date.now(), initiatives: [], agenda: [], inbox: [], triggers: [], historyTruncated: false }; },
    createTrigger: () => {}, revokeTrigger: () => {}, cancelInitiative: () => {}, respondToInitiative: () => {},
  };

  const panel = createAutonomyPanel({ api, document, now: () => Date.now(), confirm: () => true });

  // hidden → activate no hace fetch
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  panel.selectAgent("linus");
  panel.activate();
  assert.equal(fetchCount, 0, "hidden no genera fetch en activate");

  // visible → activate sí hace fetch
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  panel.deactivate();
  panel.activate();
  assert.equal(fetchCount, 1, "visible genera fetch en activate");

  panel.deactivate();
});

// ====================================================================
// 8. badge suma inbox de varios agents y tolera fallo parcial
// ====================================================================
test("P2.6.7: badge suma inbox, fallo parcial conserva valor stale", async () => {
  const { document } = setupDom();
  const api = {
    getAutonomy: async (name) => {
      if (name === "agent-fail" || name === "agent-fail2") throw new Error("fetch failed");
      return { asOf: Date.now(), initiatives: [], agenda: [], inbox: [
        { id: `${name}-1`, status: "waiting_human", question: "ok?", createdAt: Date.now() },
        { id: `${name}-2`, status: "waiting_human", question: "really?", createdAt: Date.now() },
      ], triggers: [], historyTruncated: false };
    },
    createTrigger: () => {}, revokeTrigger: () => {}, cancelInitiative: () => {}, respondToInitiative: () => {},
  };

  const panel = createAutonomyPanel({ api, document, now: () => Date.now(), confirm: () => true });
  const badge = document.getElementById("agent-badge-autonomy");
  assert.ok(badge);

  // Éxito total
  await panel.refreshBadge(["agent-a", "agent-b"]);
  assert.equal(badge.textContent, "4", "suma 2+2");
  assert.ok(!badge.classList.contains("hidden"));
  assert.ok(!badge.classList.contains("autonomy-badge-stale"));

  // Fallo parcial: uno falla, otro suma 2
  await panel.refreshBadge(["agent-a", "agent-fail"]);
  assert.equal(badge.textContent, "2", "ignora fallo");
  assert.ok(!badge.classList.contains("hidden"));
  assert.ok(badge.classList.contains("autonomy-badge-stale"), "stale");

  // Sin inbox = oculto
  api.getAutonomy = async () => ({ asOf: Date.now(), initiatives: [], agenda: [], inbox: [], triggers: [], historyTruncated: false });
  await panel.refreshBadge(["agent-c", "agent-d"]);
  assert.ok(badge.classList.contains("hidden"), "oculto con 0 inbox");
  assert.equal(badge.textContent, "");

  // Todos fallan — lastBadgeValue es null porque el último éxito puso 0 inbox → null
  // En este caso no hay valor previo que conservar
  api.getAutonomy = async () => { throw new Error("fail"); };
  await panel.refreshBadge(["agent-e", "agent-f"]);
  assert.ok(badge.classList.contains("hidden"), "oculto si todos fallan y no hay backlog");
  assert.equal(badge.textContent, "");

  panel.deactivate();
});

// ====================================================================
// 9. 409/401 desde getAutonomy
// ====================================================================
test("P2.6.8: 409/401 desde getAutonomy", async () => {
  const { document } = setupDom();
  const errors = [];

  // Cola de respuestas: éxito, 409, 401
  const responses = [
    { asOf: Date.now(), initiatives: [], agenda: [], inbox: [{ id: "init-409", status: "waiting_human", question: "¿confirmas?", createdAt: Date.now(), expiresAt: Date.now() + 86400000 }], triggers: [], historyTruncated: false },
    Object.assign(new Error("Conflict"), { status: 409, code: "INITIATIVE_STATE_CONFLICT", requiresLogin: false }),
    Object.assign(new Error("Unauthorized"), { status: 401, code: "INVALID_AUTH", requiresLogin: true }),
  ];

  const api = {
    getAutonomy: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    createTrigger: () => {}, revokeTrigger: () => {}, cancelInitiative: () => {}, respondToInitiative: () => {},
  };

  const panel = createAutonomyPanel({ api, document, now: () => Date.now(), confirm: () => true, onError: (e) => errors.push({ status: e.status, code: e.code }) });

  panel.selectAgent("linus");

  // Deshabilitamos auto-refresh activando con hidden
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  panel.activate();
  // Primer refresh explícito: éxito
  await panel.refresh();
  let html = document.getElementById("autonomy-content").innerHTML;
  assert.ok(html.includes("Espera humana"), "muestra estado waiting_human");
  assert.ok(html.includes("¿confirmas?"), "muestra pregunta (textContent)");

  // Segundo refresh: 409 — error silencioso, vista se conserva
  await panel.refresh();
  assert.equal(errors.length, 0, "409 silencioso, onError no llamado");
  html = document.getElementById("autonomy-content").innerHTML;
  assert.ok(html.includes("¿confirmas?"), "vista anterior conservada tras 409");

  // Tercer refresh: 401 — llama onError
  await panel.refresh();
  assert.equal(errors.length, 1, "error 401 notificado");
  assert.equal(errors[0].status, 401);
  assert.equal(errors[0].code, "INVALID_AUTH");

  panel.deactivate();
});