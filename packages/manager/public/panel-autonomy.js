/* panel-autonomy — vanilla DOM/flujo para la pestaña Autonomía del panel.
 * No usa framework, build step ni estado duplicado.
 * Todo texto de dominio se inserta con textContent, nunca innerHTML.
 */

const POLL_INTERVAL_PANEL = 10_000;   // 10 s
const POLL_INTERVAL_BADGE = 30_000;   // 30 s

// Labels para los ocho estados de Initiative
const STATE_LABELS = {
  queued: "En cola",
  running: "Ejecutando",
  waiting_human: "Espera humana",
  waiting_agent: "Espera agente",
  succeeded: "Completado",
  failed: "Fallido",
  expired: "Expirado",
  cancelled: "Cancelado",
};

const STATE_CLASSES = {
  queued: "state-queued",
  running: "state-running",
  waiting_human: "state-waiting-human",
  waiting_agent: "state-waiting-agent",
  succeeded: "state-succeeded",
  failed: "state-failed",
  expired: "state-expired",
  cancelled: "state-cancelled",
};

const FAILURE_LABELS = {
  turn_failed: "El turno falló",
  runner_unavailable: "Runner no disponible",
  dispatch_failed: "No se pudo despachar",
  agent_errored: "Error del agente",
  chain_deadline_exceeded: "Tiempo de cadena excedido",
  startup_recovery: "Error al recuperar",
};

// Catálogo de causas seguras para mostrar
function safeFailureReason(reason) {
  if (!reason) return null;
  return FAILURE_LABELS[reason] || "unknown";
}

function epochToDate(ms) {
  if (ms == null) return null;
  return new Date(ms);
}

function formatTime(ms) {
  const d = epochToDate(ms);
  if (!d) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDate(ms) {
  const d = epochToDate(ms);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function formatDateTime(ms) {
  const d = epochToDate(ms);
  if (!d) return "—";
  return `${formatDate(ms)} ${formatTime(ms)}`;
}

function timeAgo(ms, now) {
  if (ms == null) return "—";
  const diff = now - ms;
  if (diff < 60_000) return "ahora";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} h`;
  return `${Math.floor(diff / 86_400_000)} d`;
}

export function createAutonomyPanel({
  api,
  document: doc = document,
  confirm = globalThis.confirm,
  idFactory = crypto.randomUUID?.bind(crypto) || (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
  now = () => Date.now(),
  onError = () => {},
} = {}) {
  // --- estado interno ---
  let selectedAgent = null;
  let panelActive = false;
  let lastSnapshot = null;
  let lastBadgeValue = null;
  let panelTimer = null;
  let badgeTimer = null;
  let pendingRefresh = null;

  // --- ids de DOM (constantes para que jsdom tests puedan sobreescribir) ---
  const IDS = {
    panel: "agent-panel-autonomy",
    tab: "agent-tab-autonomy",
    content: "autonomy-content",
    badge: "agent-badge-autonomy",
    refresh: "autonomy-refresh",
    createForm: "autonomy-create-form",
    createDefinition: "autonomy-create-definition",
    createIntent: "autonomy-create-intent",
    createMode: "autonomy-create-mode",
    createSkill: "autonomy-create-skill",
    createZone: "autonomy-create-zone",
    createAt: "autonomy-create-at",
    createDays: "autonomy-create-days",
    createStatus: "autonomy-create-status",
  };

  // --- helpers DOM ---
  const $ = (id) => doc.getElementById(id);

  function el(tag, attrs = {}, children = []) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") e.className = v;
      else if (k === "textContent") e.textContent = v;
      else if (k.startsWith("data-")) e.setAttribute(k, v);
      else e[k] = v;
    }
    for (const child of children) {
      if (typeof child === "string") e.appendChild(doc.createTextNode(child));
      else if (child) e.appendChild(child);
    }
    return e;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // --- render snapshot ---
  function renderAutonomy(snapshot) {
    const container = $(IDS.content);
    if (!container) return;
    clear(container);

    if (!snapshot) {
      container.textContent = "Selecciona un agente para ver su autonomía.";
      return;
    }

    // --- Agenda (iniciativa en vuelo o primera en cola) ---
    const agendaSection = el("section", { className: "autonomy-section" });
    agendaSection.appendChild(el("h3", { className: "autonomy-section-title", textContent: "Agenda" }));

    if (snapshot.agenda && snapshot.agenda.length > 0) {
      const agendaList = el("div", { className: "autonomy-list" });
      for (let i = 0; i < snapshot.agenda.length; i++) {
        const entry = snapshot.agenda[i];
        const init = entry.initiative || entry;
        const position = entry.position || (i + 1);
        agendaList.appendChild(renderInitiativeCard(init, position, snapshot.asOf));
      }
      agendaSection.appendChild(agendaList);
    } else {
      agendaSection.appendChild(el("p", { className: "autonomy-empty", textContent: "Sin iniciativas pendientes." }));
    }
    container.appendChild(agendaSection);

    // --- En vuelo (running / waiting) ---
    const inFlight = snapshot.initiatives.filter(
      (i) => i.status === "running" || i.status === "waiting_human" || i.status === "waiting_agent",
    );
    if (inFlight.length > 0) {
      const flightSection = el("section", { className: "autonomy-section" });
      flightSection.appendChild(el("h3", { className: "autonomy-section-title", textContent: "En vuelo" }));
      const flightList = el("div", { className: "autonomy-list" });
      for (const init of inFlight) {
        flightList.appendChild(renderInitiativeCard(init, null, snapshot.asOf));
      }
      flightSection.appendChild(flightList);
      container.appendChild(flightSection);
    }

    // --- Historial reciente (terminal no cancellations viejas) ---
    const terminal = snapshot.initiatives.filter(
      (i) => i.status === "succeeded" || i.status === "failed" || i.status === "expired" || i.status === "cancelled",
    );
    if (terminal.length > 0) {
      const histSection = el("section", { className: "autonomy-section" });
      const histHeader = el("div", { className: "autonomy-section-header" });
      histHeader.appendChild(el("h3", { className: "autonomy-section-title", textContent: "Historial" }));
      if (snapshot.historyTruncated) {
        histHeader.appendChild(el("span", { className: "autonomy-truncated", textContent: "historial truncado" }));
      }
      histSection.appendChild(histHeader);
      const histList = el("div", { className: "autonomy-list" });
      for (const init of terminal) {
        histList.appendChild(renderHistoryCard(init, snapshot.asOf));
      }
      histSection.appendChild(histList);
      container.appendChild(histSection);
    }

    // --- Triggers ---
    const trigSection = el("section", { className: "autonomy-section" });
    trigSection.appendChild(el("h3", { className: "autonomy-section-title", textContent: "Triggers" }));
    if (snapshot.triggers && snapshot.triggers.length > 0) {
      const trigList = el("div", { className: "autonomy-list" });
      for (const trigger of snapshot.triggers) {
        trigList.appendChild(renderTriggerCard(trigger));
      }
      trigSection.appendChild(trigList);
    } else {
      trigSection.appendChild(el("p", { className: "autonomy-empty", textContent: "Sin triggers configurados." }));
    }
    container.appendChild(trigSection);

    // --- Inbox (waiting_human) ---
    const inboxSection = el("section", { className: "autonomy-section" });
    inboxSection.appendChild(el("h3", { className: "autonomy-section-title", textContent: "Inbox" }));
    const inboxItems = snapshot.inbox || snapshot.initiatives.filter((i) => i.status === "waiting_human");
    if (inboxItems.length > 0) {
      const inboxList = el("div", { className: "autonomy-list" });
      for (const init of inboxItems) {
        inboxList.appendChild(renderInboxCard(init));
      }
      inboxSection.appendChild(inboxList);
    } else {
      inboxSection.appendChild(el("p", { className: "autonomy-empty", textContent: "Sin preguntas pendientes." }));
    }
    container.appendChild(inboxSection);
  }

  function renderInitiativeCard(init, position, asOf) {
    const card = el("div", { className: `autonomy-card ${STATE_CLASSES[init.status] || ""}` });

    const header = el("div", { className: "autonomy-card-header" });
    if (position != null) {
      header.appendChild(el("span", { className: "autonomy-position", textContent: `#${position}` }));
    }
    const stateLabel = STATE_LABELS[init.status] || init.status;
    header.appendChild(el("span", { className: `autonomy-state ${STATE_CLASSES[init.status] || ""}`, textContent: stateLabel }));
    if (init.mode) {
      header.appendChild(el("span", { className: "autonomy-mode", textContent: init.mode }));
    }
    if (init.origin) {
      header.appendChild(el("span", { className: "autonomy-origin", textContent: init.origin }));
    }
    card.appendChild(header);

    if (init.intent) {
      const intentEl = el("div", { className: "autonomy-intent" });
      intentEl.textContent = init.intent;
      card.appendChild(intentEl);
    }
    if (init.summary) {
      const summaryEl = el("div", { className: "autonomy-summary" });
      summaryEl.textContent = init.summary;
      card.appendChild(summaryEl);
    }

    const meta = el("div", { className: "autonomy-meta" });
    if (asOf && init.startedAt) {
      meta.appendChild(el("span", { className: "autonomy-meta-item", textContent: `lleva ${timeAgo(init.startedAt, asOf)}` }));
    }
    if (init.availableAt) {
      meta.appendChild(el("span", { className: "autonomy-meta-item", textContent: `disponible ${formatDateTime(init.availableAt)}` }));
    }
    if (init.stateChangedAt) {
      meta.appendChild(el("span", { className: "autonomy-meta-item", textContent: `cambio ${formatDateTime(init.stateChangedAt)}` }));
    }
    if (init.expiresAt && (init.status === "waiting_human" || init.status === "queued")) {
      meta.appendChild(el("span", { className: "autonomy-meta-item autonomy-expiry", textContent: `expira ${formatDateTime(init.expiresAt)}` }));
    }
    card.appendChild(meta);

    return card;
  }

  function renderHistoryCard(init, asOf) {
    const card = el("div", { className: `autonomy-card autonomy-history-card ${STATE_CLASSES[init.status] || ""}` });

    const header = el("div", { className: "autonomy-card-header" });
    const stateLabel = STATE_LABELS[init.status] || init.status;
    header.appendChild(el("span", { className: `autonomy-state ${STATE_CLASSES[init.status] || ""}`, textContent: stateLabel }));
    if (init.mode) {
      header.appendChild(el("span", { className: "autonomy-mode", textContent: init.mode }));
    }
    card.appendChild(header);

    if (init.summary) {
      const summaryEl = el("div", { className: "autonomy-summary" });
      summaryEl.textContent = init.summary;
      card.appendChild(summaryEl);
    }

    const failureReason = safeFailureReason(init.failureReason);
    if (failureReason && failureReason !== "unknown") {
      card.appendChild(el("div", { className: "autonomy-failure", textContent: failureReason }));
    }
    if (init.finishedAt) {
      card.appendChild(el("div", { className: "autonomy-meta" }));
      card.querySelector(".autonomy-meta")?.appendChild(
        el("span", { className: "autonomy-meta-item", textContent: `terminó ${formatDateTime(init.finishedAt)}` }),
      );
    }

    return card;
  }

  function renderTriggerCard(trigger) {
    const card = el("div", { className: `autonomy-card ${trigger.enabled ? "" : "autonomy-trigger-revoked"}` });

    const header = el("div", { className: "autonomy-card-header" });
    header.appendChild(el("span", { className: "autonomy-trigger-kind", textContent: trigger.kind || (trigger.definition?.kind || "trigger") }));
    header.appendChild(el("span", { className: `autonomy-state ${trigger.enabled ? "state-queued" : "state-cancelled"}`,
      textContent: trigger.enabled ? "Activo" : "Revocado" }));
    card.appendChild(header);

    // Schedule civil
    if (trigger.definition) {
      const def = trigger.definition;
      let scheduleText = "";
      if (def.version === 2) {
        if (def.kind === "daily") {
          scheduleText = `Diario a las ${def.at} (${def.timeZone || "UTC"})`;
        } else if (def.kind === "weekly") {
          const days = (def.days || []).map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(", ");
          scheduleText = `${days} a las ${def.at} (${def.timeZone || "UTC"})`;
        }
      } else if (def.version === 1) {
        scheduleText = `Cada ${def.intervalMs ? Math.round(def.intervalMs / 1000) : "?"}s`;
      }
      if (scheduleText) {
        card.appendChild(el("div", { className: "autonomy-schedule", textContent: scheduleText }));
      }
    }

    if (trigger.intent) {
      const intentEl = el("div", { className: "autonomy-intent" });
      intentEl.textContent = trigger.intent;
      card.appendChild(intentEl);
    }

    if (trigger.mode) {
      card.appendChild(el("div", { className: "autonomy-mode", textContent: trigger.mode }));
    }

    const meta = el("div", { className: "autonomy-meta" });
    if (trigger.nextFireAt) {
      meta.appendChild(el("span", { className: "autonomy-meta-item", textContent: `próximo ${formatDateTime(trigger.nextFireAt)}` }));
    }
    if (trigger.lastFiredAt) {
      meta.appendChild(el("span", { className: "autonomy-meta-item", textContent: `último ${formatDateTime(trigger.lastFiredAt)}` }));
    }
    if (trigger.createdBy) {
      meta.appendChild(el("span", { className: "autonomy-meta-item", textContent: `creado por ${trigger.createdBy}` }));
    }
    if (trigger.authority) {
      meta.appendChild(el("span", { className: "autonomy-meta-item", textContent: `autoridad ${trigger.authority}` }));
    }
    card.appendChild(meta);

    // Acciones
    if (trigger.enabled && trigger.id) {
      const actions = el("div", { className: "autonomy-card-actions" });
      const revokeBtn = el("button", {
        className: "btn btn-ghost btn-sm",
        textContent: "Revocar",
        type: "button",
      });
      revokeBtn.style.color = "var(--danger)";
      revokeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleRevokeTrigger(trigger.id);
      });
      actions.appendChild(revokeBtn);
      card.appendChild(actions);
    }

    return card;
  }

  function renderInboxCard(init) {
    const card = el("div", { className: `autonomy-card autonomy-inbox-card ${STATE_CLASSES[init.status] || ""}` });

    const header = el("div", { className: "autonomy-card-header" });
    const stateLabel = STATE_LABELS[init.status] || init.status;
    header.appendChild(el("span", { className: `autonomy-state ${STATE_CLASSES[init.status] || ""}`, textContent: stateLabel }));
    if (init.mode) {
      header.appendChild(el("span", { className: "autonomy-mode", textContent: init.mode }));
    }
    card.appendChild(header);

    if (init.question) {
      const questionEl = el("div", { className: "autonomy-question" });
      questionEl.textContent = init.question;
      card.appendChild(questionEl);
    }
    if (init.summary) {
      const summaryEl = el("div", { className: "autonomy-summary" });
      summaryEl.textContent = init.summary;
      card.appendChild(summaryEl);
    }

    const meta = el("div", { className: "autonomy-meta" });
    if (init.createdAt) {
      meta.appendChild(el("span", { className: "autonomy-meta-item", textContent: `recibida ${formatDateTime(init.createdAt)}` }));
    }
    if (init.expiresAt) {
      meta.appendChild(el("span", { className: "autonomy-meta-item", textContent: `expira ${formatDateTime(init.expiresAt)}` }));
    }
    card.appendChild(meta);

    if (init.notificationStatus === "not_delivered") {
      const warning = el("div", {
        className: "autonomy-respond-status",
        textContent: "No se pudo enviar la notificación por Telegram. Responde aquí en el panel.",
      });
      warning.setAttribute("role", "alert");
      card.appendChild(warning);
    }

    if (init.id) {
      const respondArea = el("div", { className: "autonomy-respond-area" });
      const textarea = el("textarea", {
        className: "input autonomy-respond-input",
        placeholder: "Escribe tu respuesta…",
        rows: 2,
      });
      respondArea.appendChild(textarea);

      const btnRow = el("div", { className: "autonomy-respond-actions" });
      const respondBtn = el("button", { className: "btn btn-primary btn-sm", textContent: "Responder", type: "button" });
      const cancelBtn = el("button", { className: "btn btn-ghost btn-sm", textContent: "Cancelar", type: "button" });
      cancelBtn.style.color = "var(--danger)";
      const statusMsg = el("span", { className: "autonomy-respond-status" });

      // Key durable: se genera al mostrar y se conserva para retry
      let respondKey = idFactory();

      respondBtn.addEventListener("click", async () => {
        const answer = textarea.value.trim();
        if (!answer) return;
        respondBtn.disabled = true;
        statusMsg.textContent = "Enviando…";
        try {
          await api.respondToInitiative(selectedAgent, init.id, answer, respondKey);
          statusMsg.textContent = "✔ Respondida";
          textarea.value = "";
          // Tras éxito, refrescar
          scheduledRefresh();
        } catch (error) {
          // Conservar key en error para retry con mismo payload
          statusMsg.textContent = `Error: ${error.message || "fallo"}`;
          respondBtn.disabled = false;
          onError(error);
        }
      });

      cancelBtn.addEventListener("click", async () => {
        if (!confirm(`¿Cancelar esta iniciativa?`)) return;
        cancelBtn.disabled = true;
        statusMsg.textContent = "Cancelando…";
        try {
          const result = await api.cancelInitiative(selectedAgent, init.id);
          const label = result.status === "cancellation_requested"
            ? "Cancelación solicitada"
            : "Cancelada";
          statusMsg.textContent = `✔ ${label}`;
          scheduledRefresh();
        } catch (error) {
          statusMsg.textContent = `Error: ${error.message || "fallo"}`;
          cancelBtn.disabled = false;
          onError(error);
        }
      });

      btnRow.appendChild(respondBtn);
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(statusMsg);
      respondArea.appendChild(btnRow);
      card.appendChild(respondArea);
    }

    return card;
  }

  // --- Acciones ---

  async function handleRevokeTrigger(triggerId) {
    if (!selectedAgent) return;
    if (!confirm(`¿Revocar este trigger?`)) return;
    try {
      await api.revokeTrigger(selectedAgent, triggerId);
      scheduledRefresh();
    } catch (error) {
      onError(error);
    }
  }

  async function handleCancelInitiative(initiativeId) {
    if (!selectedAgent) return;
    if (!confirm(`¿Cancelar la iniciativa en curso?`)) return;
    try {
      const result = await api.cancelInitiative(selectedAgent, initiativeId);
      // Mostrar 200 o 202
      scheduledRefresh();
    } catch (error) {
      onError(error);
    }
  }

  async function handleCreateTrigger(event) {
    event.preventDefault();
    const statusEl = $(IDS.createStatus);
    if (!statusEl) return;

    const kind = $(IDS.createDefinition)?.value || "daily";
    const intent = $(IDS.createIntent)?.value.trim();
    const mode = $(IDS.createMode)?.value || "solo";
    const skill = $(IDS.createSkill)?.value.trim() || null;
    const zone = $(IDS.createZone)?.value.trim() || "UTC";
    const at = $(IDS.createAt)?.value || "09:00";
    const daysStr = $(IDS.createDays)?.value?.trim();

    if (!intent) {
      statusEl.textContent = "El intent es obligatorio.";
      return;
    }

    let definition;
    if (kind === "daily") {
      definition = { version: 2, kind: "daily", timeZone: zone, at };
    } else if (kind === "weekly") {
      const days = daysStr ? daysStr.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean) : ["mon"];
      definition = { version: 2, kind: "weekly", timeZone: zone, at, days };
    } else {
      statusEl.textContent = "Tipo no soportado.";
      return;
    }

    const command = { definition, intent, mode, suggestedSkill: skill || null };
    const key = idFactory();

    statusEl.textContent = "Creando…";
    try {
      await api.createTrigger(selectedAgent, command, key);
      statusEl.textContent = "✔ Trigger creado";
      $(IDS.createIntent).value = "";
      $(IDS.createSkill).value = "";
      scheduledRefresh();
    } catch (error) {
      statusEl.textContent = `Error: ${error.message || "fallo"}`;
      onError(error);
    }
  }

  // --- Polling / visibility ---

  function scheduledRefresh() {
    if (!panelActive || !selectedAgent) return;
    // Usar microtask para coalescer refrescos rápidos
    if (!pendingRefresh) {
      pendingRefresh = Promise.resolve().then(() => {
        pendingRefresh = null;
        return refresh();
      });
    }
    return pendingRefresh;
  }

  async function refresh() {
    if (!selectedAgent || !panelActive) return;
    try {
      const snapshot = await api.getAutonomy(selectedAgent);
      lastSnapshot = snapshot;
      renderAutonomy(snapshot);
    } catch (error) {
      if (error.requiresLogin) onError(error);
      // En error, mantener la última vista
    }
  }

  async function refreshBadge(agentNames) {
    if (!agentNames || !agentNames.length) {
      const badge = $(IDS.badge);
      if (badge) {
        badge.textContent = "";
        badge.classList.add("hidden");
      }
      lastBadgeValue = null;
      return;
    }

    const results = await Promise.allSettled(
      agentNames.map((name) => api.getAutonomy(name)),
    );

    let total = 0;
    let hadFailure = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        const snapshot = result.value;
        total += (snapshot.inbox || snapshot.initiatives?.filter((i) => i.status === "waiting_human") || []).length;
      } else {
        hadFailure = true;
      }
    }

    const badge = $(IDS.badge);
    if (!badge) return;

    if (total > 0) {
      badge.textContent = String(total);
      badge.classList.remove("hidden");
      badge.classList.toggle("autonomy-badge-stale", hadFailure);
    } else if (hadFailure && lastBadgeValue != null) {
      // Conservar último valor y marcar stale
      badge.textContent = String(lastBadgeValue);
      badge.classList.remove("hidden");
      badge.classList.add("autonomy-badge-stale");
    } else {
      badge.textContent = "";
      badge.classList.add("hidden");
      badge.classList.remove("autonomy-badge-stale");
    }
    lastBadgeValue = total > 0 ? total : hadFailure ? lastBadgeValue : null;
  }

  // --- Ciclo de vida ---

  function selectAgent(name) {
    selectedAgent = name;
    if (name) {
      lastSnapshot = null;
      renderAutonomy(null);
      if (panelActive) void refresh();
    } else {
      lastSnapshot = null;
      const container = $(IDS.content);
      if (container) container.textContent = "Selecciona un agente para ver su autonomía.";
    }
  }

  function activate() {
    if (panelActive) return;
    panelActive = true;

    // Suscribir handler del form si existe
    const form = $(IDS.createForm);
    if (form) {
      form.addEventListener("submit", handleCreateTrigger);
    }

    // Panel refresh cada 10s
    clearInterval(panelTimer);
    panelTimer = setInterval(() => {
      if (doc.visibilityState === "visible" && selectedAgent) {
        void refresh();
      }
    }, POLL_INTERVAL_PANEL);

    // Refresh inmediato si hay agente seleccionado y documento visible
    if (selectedAgent && doc.visibilityState === "visible") void refresh();
  }

  function deactivate() {
    panelActive = false;
    clearInterval(panelTimer);
    panelTimer = null;
    pendingRefresh = null;
  }

  function startBadgeTimer(agentNames) {
    clearInterval(badgeTimer);
    // Primer badge inmediato
    if (agentNames) void refreshBadge(agentNames);

    badgeTimer = setInterval(() => {
      if (doc.visibilityState === "visible" && agentNames) {
        void refreshBadge(agentNames);
      }
    }, POLL_INTERVAL_BADGE);
  }

  function stopBadgeTimer() {
    clearInterval(badgeTimer);
    badgeTimer = null;
  }

  return {
    selectAgent,
    activate,
    deactivate,
    refresh,
    refreshBadge,
    startBadgeTimer,
    stopBadgeTimer,
    // Para tests
    _ids: IDS,
  };
}