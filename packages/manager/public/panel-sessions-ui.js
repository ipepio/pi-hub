/*
 * Selector de sesiones del panel web (S2/S3/S4).
 *
 * Qué es: la única superficie que pinta el catálogo durable de sesiones de un Agent
 * dentro del panel. Toda la copy sale de `panel-labels.js` (S4): aquí no hay ni un
 * literal en español que el usuario pueda leer.
 *
 * Qué NO es: no es la autoridad del catálogo. Listar, crear y seleccionar son
 * llamadas al Manager (`panel-sessions.js`); el panel solo refleja lo que el catálogo
 * responde, y si no responde lo dice en vez de inventarse una sesión — una key
 * generada por el cliente recrearía las sesiones huérfanas que esta unidad cierra.
 *
 * Reglas observables:
 *   - El concepto ambiguo (varias sesiones del MISMO Agent; una sesión histórica
 *     read-only por el ADR 0107) se explica con `title` nativo en un elemento
 *     enfocable: el panel no tiene componente de tooltip.
 *   - Una fecha desconocida (epoch 0 de la entrada legacy, o `null`) se dice, nunca se
 *     sustituye por el reloj (S7).
 *   - La key del Runner NO se pinta nunca: vive en el payload porque el panel la
 *     necesita para abrir el turno, no porque el humano tenga que verla.
 *   - Confirmaciones en `role="status"`; errores en `role="alert"`.
 */
import { SESSIONS_PANEL_LABELS, formatLabel } from "./panel-labels.js";

/**
 * Fecha fijada en `es-ES` y UTC para que no dependa del navegador ni salte de día por
 * la zona horaria. Se compara con el MISMO formato que usa el dashboard.
 */
const SESSION_DATE_FORMAT = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

/** `createdAt` honesto: epoch 0 y valores ilegibles son "desconocida", no una fecha. */
export function sessionCreatedAtLabel(createdAt, labels = SESSIONS_PANEL_LABELS) {
  if (!createdAt) return labels.sessionUnknownDate;
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp) || timestamp === 0) return labels.sessionUnknownDate;
  return SESSION_DATE_FORMAT.format(new Date(timestamp));
}

export function createSessionsPanel({
  container,
  panelSessions,
  labels = SESSIONS_PANEL_LABELS,
  onSessionSelected,
} = {}) {
  const doc = container?.ownerDocument ?? globalThis.document;

  function emptyState() {
    return {
      agent: null,
      sessions: null,
      selection: { web: null, telegram: null },
      loading: false,
      error: false,
      notice: null,
      actionError: false,
      busy: false,
    };
  }

  let state = emptyState();

  // ---------- esqueleto (se construye una vez; los datos se pintan como texto) ----------
  const section = doc.createElement("section");
  section.className = "agent-sessions";

  const heading = doc.createElement("div");
  heading.className = "agent-sessions-heading";
  const title = doc.createElement("h3");
  title.className = "agent-sessions-title";
  title.textContent = labels.sessionsHeading;
  // Disparador del tooltip: enfocable y con nombre accesible propio, porque el texto
  // del tooltip es la explicación, no el nombre del control.
  const tooltip = doc.createElement("span");
  tooltip.className = "agent-sessions-tooltip";
  tooltip.setAttribute("tabindex", "0");
  tooltip.setAttribute("role", "note");
  tooltip.setAttribute("title", labels.sessionsTooltip);
  tooltip.setAttribute("aria-label", labels.sessionsTooltipLabel);
  tooltip.textContent = "ⓘ";
  heading.append(title, tooltip);

  const status = doc.createElement("p");
  status.className = "agent-sessions-status list-item-sub";
  status.setAttribute("role", "status");

  const alert = doc.createElement("p");
  alert.className = "agent-sessions-alert list-item-sub";
  alert.setAttribute("role", "alert");

  const retry = doc.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-ghost btn-sm";
  retry.dataset.action = "retry";
  retry.textContent = labels.sessionsRetryAction;
  retry.hidden = true;
  retry.addEventListener("click", () => void load());

  const list = doc.createElement("ul");
  list.className = "agent-sessions-list";

  const form = doc.createElement("form");
  form.className = "agent-sessions-create";
  form.dataset.form = "create";
  form.hidden = true;
  const nameInput = doc.createElement("input");
  nameInput.className = "input";
  nameInput.type = "text";
  nameInput.setAttribute("placeholder", labels.sessionNamePlaceholder);
  nameInput.setAttribute("aria-label", labels.sessionNamePlaceholder);
  const createButton = doc.createElement("button");
  createButton.type = "submit";
  createButton.className = "btn btn-primary btn-sm";
  createButton.dataset.action = "create";
  createButton.textContent = labels.sessionCreateAction;
  form.append(nameInput, createButton);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const requested = nameInput.value;
    nameInput.value = "";
    void createSession(requested);
  });

  section.append(heading, status, alert, retry, list, form);
  container?.replaceChildren(section);

  // ---------- proyección del estado ----------
  function selectedWebSession() {
    const id = state.selection?.web;
    if (!id || !Array.isArray(state.sessions)) return null;
    return state.sessions.find((item) => item.id === id) ?? null;
  }

  function paintRow(item) {
    const row = doc.createElement("li");
    row.className = "agent-sessions-row";
    row.dataset.sessionId = item.id;

    const main = doc.createElement("div");
    main.className = "agent-sessions-row-main";

    const name = doc.createElement("span");
    name.className = "agent-sessions-name";
    name.textContent = item.name || labels.sessionUnnamed;
    main.appendChild(name);

    if (item.legacy) {
      const badge = doc.createElement("span");
      badge.className = "chip agent-sessions-legacy";
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("role", "note");
      badge.setAttribute("title", labels.sessionLegacyTooltip);
      badge.setAttribute("aria-label", labels.sessionLegacyTooltipLabel);
      badge.textContent = labels.sessionLegacy;
      main.appendChild(badge);
    }

    const created = doc.createElement("span");
    created.className = "agent-sessions-date";
    created.textContent = sessionCreatedAtLabel(item.createdAt, labels);
    main.appendChild(created);

    if (item.id === state.selection?.web) {
      const mark = doc.createElement("span");
      mark.className = "agent-sessions-mark";
      mark.textContent = labels.sessionSelectedWeb;
      main.appendChild(mark);
    }
    if (item.id === state.selection?.telegram) {
      const mark = doc.createElement("span");
      mark.className = "agent-sessions-mark";
      mark.textContent = labels.sessionTelegramMark;
      main.appendChild(mark);
    }

    const selectButton = doc.createElement("button");
    selectButton.type = "button";
    selectButton.className = "btn btn-secondary btn-sm";
    selectButton.dataset.action = "select";
    selectButton.textContent = labels.sessionSelectAction;
    selectButton.setAttribute(
      "aria-label",
      formatLabel(labels.sessionSelectActionFor, { name: name.textContent }),
    );
    selectButton.disabled = state.busy || item.id === state.selection?.web;
    selectButton.addEventListener("click", () => void selectSession(item.id));

    row.append(main, selectButton);
    return row;
  }

  function paint() {
    title.textContent = labels.sessionsHeading;
    tooltip.setAttribute("title", labels.sessionsTooltip);
    tooltip.setAttribute("aria-label", labels.sessionsTooltipLabel);

    list.replaceChildren();
    for (const item of state.sessions || []) list.appendChild(paintRow(item));

    if (state.loading) status.textContent = labels.sessionsLoading;
    else if (state.notice) status.textContent = state.notice;
    else if (state.sessions && !state.sessions.length) status.textContent = labels.sessionsEmpty;
    else status.textContent = "";

    const messages = [];
    if (state.error) messages.push(labels.sessionsLoadError);
    if (state.actionError) messages.push(labels.sessionActionError);
    alert.textContent = messages.join(" ");
    retry.hidden = !state.error;
    retry.disabled = state.busy || state.loading;

    // Sin catálogo conocido no se ofrece crear: no se sabría qué queda seleccionado.
    form.hidden = state.sessions === null;
    nameInput.disabled = state.busy;
    createButton.disabled = state.busy;
  }

  // ---------- operaciones ----------
  function notify(info) {
    if (typeof onSessionSelected !== "function") return;
    if (info.status === "error") {
      onSessionSelected(null, info);
      return;
    }
    onSessionSelected(selectedWebSession(), info);
  }

  async function load() {
    const agent = state.agent;
    if (!agent) return null;
    state.loading = true;
    state.error = false;
    paint();
    let snapshot;
    try {
      snapshot = await panelSessions.list(agent);
    } catch (error) {
      // Respuesta tardía de un Agent que ya no está abierto: se descarta entera, para
      // no adoptar la sesión de otro Agent ni pintar su error.
      if (state.agent !== agent) return null;
      state.loading = false;
      state.error = true;
      state.sessions = null;
      state.selection = { web: null, telegram: null };
      // Un aviso de una acción anterior describiría un estado que ya no se conoce.
      state.notice = null;
      paint();
      // Fallo cerrado: sin catálogo no hay sesión que adoptar, así que el panel no
      // puede empezar un turno con una key inventada.
      notify({ status: "error", error });
      return null;
    }
    if (state.agent !== agent) return null;
    state.loading = false;
    state.sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
    state.selection = {
      web: snapshot?.selection?.web ?? null,
      telegram: snapshot?.selection?.telegram ?? null,
    };
    paint();
    notify({ status: "ready" });
    return snapshot;
  }

  async function createSession(name) {
    const agent = state.agent;
    if (!agent || !panelSessions?.create) return null;
    const requested = typeof name === "string" ? name.trim() : "";
    state.actionError = false;
    setBusy(true);
    let created;
    try {
      created = await panelSessions.create(agent, requested ? { name: requested } : {});
    } catch {
      if (state.agent !== agent) return null;
      state.actionError = true;
      setBusy(false);
      return null;
    }
    if (!created?.id) {
      state.actionError = true;
      setBusy(false);
      return null;
    }
    try {
      await panelSessions.select(agent, created.id, "web");
    } catch {
      if (state.agent !== agent) return null;
      // La sesión existe aunque su selección fallara: se reevalúa el catálogo antes
      // de avisar, para no enseñar dos veces «no existe» y «no se pudo seleccionar».
      state.actionError = true;
      await load();
      state.actionError = true;
      setBusy(false);
      return null;
    }
    if (state.agent !== agent) return null;
    state.notice = labels.sessionCreatedConfirmation;
    await load();
    setBusy(false);
    return created;
  }

  async function selectSession(sessionId) {
    const agent = state.agent;
    if (!agent || !sessionId || !panelSessions?.select) return null;
    state.actionError = false;
    setBusy(true);
    let result;
    try {
      result = await panelSessions.select(agent, sessionId, "web");
    } catch {
      if (state.agent !== agent) return null;
      state.actionError = true;
      await load();
      state.actionError = true;
      setBusy(false);
      return null;
    }
    if (state.agent !== agent) return null;
    state.notice = labels.sessionSelectedConfirmation;
    await load();
    setBusy(false);
    return result?.session ?? selectedWebSession();
  }

  function setBusy(busy) {
    state.busy = Boolean(busy);
    paint();
  }

  return {
    /** Re-pinta con un estado parcial (catálogo, selección, avisos, `busy`). */
    render(next = {}) {
      state = { ...state, ...next };
      paint();
    },
    setBusy,
    /** Cambia de Agent y deja el panel en su estado de carga. */
    open(agentName) {
      state = { ...emptyState(), agent: agentName, loading: Boolean(agentName) };
      paint();
    },
    load,
    createSession,
    selectSession,
  };
}
