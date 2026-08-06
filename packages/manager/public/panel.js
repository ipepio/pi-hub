/* pihub — panel del manager (vanilla JS, sin build) */
import { createPanelApi, PanelApiError } from "/panel-api.js";
import { createPanelTurns } from "/panel-turns.js";
import { renderMarkdown } from "/markdown.js";

const $ = (id) => document.getElementById(id);
let selectedAgent = null;
let currentTurn = null;
let sessionKey = null;
let currentAgentResponse = null;
let currentAgentThinking = null;
const panelApi = createPanelApi();
const panelTurns = createPanelTurns();

// Re-parsing the whole accumulated response through renderMarkdown on every
// single delta is O(n^2) over a response and freezes the tab on long
// replies. Coalesce to at most one render per animation frame instead.
let pendingAgentRenderEl = null;
let agentRenderScheduled = false;
function scheduleAgentMarkdownRender(el) {
  pendingAgentRenderEl = el;
  if (agentRenderScheduled) return;
  agentRenderScheduled = true;
  requestAnimationFrame(() => {
    agentRenderScheduled = false;
    if (pendingAgentRenderEl) {
      pendingAgentRenderEl.innerHTML = renderMarkdown(pendingAgentRenderEl.markdownSource);
      pendingAgentRenderEl = null;
      scrollAgentChat();
    }
  });
}

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const label = $("theme-label");
  if (label) label.textContent = theme === "dark" ? "Tema claro" : "Tema oscuro";
}
applyTheme(localStorage.getItem("pihub-theme") || "dark");
$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem("pihub-theme", next);
  applyTheme(next);
});

// ---------- mobile sidebar ----------
function openSidebar() {
  $("sidebar").classList.add("open");
  $("sidebar-overlay").classList.add("active");
}
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-overlay").classList.remove("active");
}
$("hamburger").addEventListener("click", openSidebar);
$("sidebar-overlay").addEventListener("click", closeSidebar);

// ---------- Autonomía ----------
const autonomyPanel = createAutonomyPanel({ api: panelApi, onError: (error) => {
  if (error instanceof PanelApiError && error.requiresLogin) showLogin();
} });

// ---------- navigation ----------
function navigate(screen) {
  if (screen !== "agent" && currentTurn) void abortCurrentTurn({ silent: true });
  if (screen !== "agent") autonomyPanel.deactivate();
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(`screen-${screen}`)?.classList.add("active");
  document.querySelectorAll(".sidebar-link").forEach((l) =>
    l.classList.toggle("active", l.dataset.screen === screen),
  );
  closeSidebar();
}
document.querySelectorAll(".sidebar-link").forEach((l) =>
  l.addEventListener("click", () => navigate(l.dataset.screen)),
);

// ---------- auth ----------
function showLogin() {
  $("login").classList.remove("hidden");
  $("app").classList.add("hidden");
}

function panelErrorMessage(error, fallback = "No se pudo completar la operación") {
  if (error instanceof PanelApiError && error.code === "TURN_IN_PROGRESS") {
    return "Hay un turno en curso; espera a que termine o cancélalo antes de cambiar el modelo.";
  }
  if (error instanceof PanelApiError && error.isCsrfError) {
    return "La sesión del panel necesita una recarga para validar CSRF.";
  }
  return error?.message || fallback;
}

function showPanelError(error, fallback) {
  if (error instanceof PanelApiError && error.requiresLogin) showLogin();
  addAgentSystem(`⚠️ ${panelErrorMessage(error, fallback)}`);
}

function csrfCookieValue() {
  const prefix = "pihub_csrf=";
  return document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) || "";
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ token: $("token-input").value }),
  });
  if (res.ok) {
    const body = await res.json();
    panelApi.setCsrfToken(body.csrfToken || csrfCookieValue());
    panelTurns.setCsrfToken(body.csrfToken || csrfCookieValue());
    $("login-error").textContent = "";
    init();
  } else $("login-error").textContent = "Token incorrecto";
});

// ---------- agentes ----------
const STATE_CHIP = {
  running: { cls: "chip-ok", label: "Ejecutando" },
  errored: { cls: "chip-danger", label: "Error" },
  stopped: { cls: "", label: "Detenido" },
};

async function loadAgents() {
  let agents;
  try {
    agents = await panelApi.listAgents();
  } catch (error) {
    if (error instanceof PanelApiError && error.requiresLogin) showLogin();
    return;
  }
  const wrap = $("agent-list");
  wrap.innerHTML = "";
  if (!agents.length) {
    const empty = document.createElement("p");
    empty.className = "list-item-sub";
    empty.textContent = "— sin agentes —";
    wrap.appendChild(empty);
    return;
  }
  for (const agent of agents) {
    const card = document.createElement("div");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "card-header";
    const title = document.createElement("span");
    title.className = "card-title";
    title.textContent = agent.name;
    const st = STATE_CHIP[agent.state] || STATE_CHIP.stopped;
    const chip = document.createElement("span");
    chip.className = `chip ${st.cls}`.trim();
    chip.innerHTML = '<span class="chip-dot"></span>';
    chip.append(` ${st.label}`);
    header.append(title, chip);

    const meta = document.createElement("p");
    meta.className = "list-item-sub";
    meta.textContent = `${agent.model || "modelo por defecto"}${agent.telegram ? " · ✈ telegram" : ""}`;

    const conversation = document.createElement("button");
    conversation.type = "button";
    conversation.className = "agent-conversation-link";
    conversation.setAttribute("aria-label", `Abrir chat de ${agent.name}`);
    conversation.onclick = () => openAgent(agent);
    conversation.append(header, meta);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "var(--space-2)";
    actions.style.flexWrap = "wrap";

    const running = agent.state === "running";
    const primary = document.createElement("button");
    primary.className = "btn btn-secondary btn-sm";
    primary.textContent = running ? "Detener" : "Iniciar";
    primary.onclick = async () => {
      primary.disabled = true;
      try {
        if (running) await panelApi.stopAgent(agent.name);
        else await panelApi.startAgent(agent.name);
        await loadAgents();
      } catch (error) {
        showPanelError(error);
      } finally {
        primary.disabled = false;
      }
    };

    const restart = document.createElement("button");
    restart.className = "btn btn-secondary btn-sm";
    restart.textContent = "Reiniciar";
    restart.onclick = async () => {
      restart.disabled = true;
      try {
        await panelApi.restartAgent(agent.name);
        await loadAgents();
      } catch (error) {
        showPanelError(error);
      } finally {
        restart.disabled = false;
      }
    };

    const chat = document.createElement("button");
    chat.className = "btn btn-primary btn-sm";
    chat.type = "button";
    chat.textContent = "Abrir chat";
    chat.onclick = () => openAgent(agent);

    const del = document.createElement("button");
    del.className = "btn btn-ghost btn-sm";
    del.style.color = "var(--danger)";
    del.textContent = "Borrar";
    del.onclick = async () => {
      if (!confirm(`¿Borrar el agente "${agent.name}" y todos sus datos?`)) return;
      try {
        await panelApi.deleteAgent(agent.name);
        await loadAgents();
      } catch (error) {
        showPanelError(error);
      }
    };

    actions.append(primary, restart, chat, del);
    card.append(conversation, actions);
    wrap.appendChild(card);
  }
  // Badge refresh tras recargar agentes
  setTimeout(() => {
    const agentNames = Array.from(document.querySelectorAll(".card-title")).map((el) => el.textContent).filter(Boolean);
    if (agentNames.length) autonomyPanel.refreshBadge(agentNames);
  }, 100);
}

// ---------- Modelos disponibles ----------
let modelCatalog = [];
let selectedAgentModel = "";

async function loadModels() {
  const response = await panelApi.listModels().catch((error) => {
    if (error instanceof PanelApiError && error.requiresLogin) showLogin();
    return null;
  });
  if (!response) return;
  modelCatalog = response.models || [];
  if (!modelCatalog.length) return; // sin catálogo: queda el input libre
  const sel = $("new-model-select");
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Modelo por defecto";
  sel.appendChild(none);
  for (const m of modelCatalog) {
    const opt = document.createElement("option");
    opt.value = `${m.provider}/${m.id}`;
    opt.textContent = m.configured ? m.name : `${m.name} (sin credenciales)`;
    sel.appendChild(opt);
  }
  sel.classList.remove("hidden");
  $("new-model").classList.add("hidden");
}

function setAgentModel(model) {
  selectedAgentModel = model || "";
  $("selected-agent-model").textContent = selectedAgentModel || "modelo por defecto";
}

// ---------- Agent workspace: chat + resources ----------
function openAgent(agent) {
  selectedAgent = agent;
  sessionKey = panelTurns.createSessionKey();
  currentTurn = null;
  setAgentModel(agent.model || "");
  $("selected-agent-name").textContent = agent.name;
  $("agent-messages").innerHTML = "";
  switchAgentPanel("chat");
  navigate("agent");
  setAgentConnection(true, "Listo");
  void loadAgentCommands();
  autonomyPanel.selectAgent(agent.name);
}

function setAgentConnection(connected, label = connected ? "Listo" : "Desconectado") {
  $("agent-connection").classList.toggle("chip-ok", connected);
  $("agent-connection-text").textContent = label;
}

function finishTurn(turnId, statusMessage) {
  if (currentTurn?.turnId !== turnId) return;
  $("agent-abort").classList.add("hidden");
  currentAgentResponse?.classList.remove("streaming");
  currentAgentResponse = null;
  currentAgentThinking = null;
  currentTurn = null;
  setAgentConnection(true, "Listo");
  if (statusMessage) addAgentSystem(statusMessage);
}

function handleTurnEvent(event, turnId) {
  const data = event.data || {};
  switch (event.event) {
    case "turn-start":
      $("agent-abort").classList.remove("hidden");
      break;
    case "chunk":
      if (!currentAgentResponse) {
        currentAgentResponse = addAgentMessage("assistant");
        currentAgentResponse.classList.add("streaming");
      }
      currentAgentResponse.markdownSource = (currentAgentResponse.markdownSource || "") + (data.delta || "");
      scheduleAgentMarkdownRender(currentAgentResponse);
      break;
    case "thinking-delta":
      if (!currentAgentThinking) currentAgentThinking = addAgentMessage("thinking");
      currentAgentThinking.textContent += data.delta || "";
      scrollAgentChat();
      break;
    case "tool-start":
      addAgentSystem(`Ejecutando ${data.toolName || "tool"}…`);
      currentAgentResponse?.classList.remove("streaming");
      currentAgentResponse = null;
      break;
    case "tool-end":
      addAgentSystem(`${data.isError ? "⚠️ " : "✔ "}${data.toolName || "tool"} ${data.isError ? "falló" : "terminó"}`);
      break;
    case "turn-complete":
      finishTurn(turnId);
      break;
    case "turn-aborted":
      finishTurn(turnId, "— respuesta cancelada —");
      break;
    case "turn-error":
      finishTurn(turnId, `⚠️ ${data.message || "El Agent no pudo completar el turno"}`);
      break;
  }
}

async function consumeTurn(turn) {
  setAgentConnection(true, "Conectando…");
  try {
    for await (const event of turn.events) {
      if (currentTurn?.turnId === turn.turnId) handleTurnEvent(event, turn.turnId);
    }
    if (currentTurn?.turnId === turn.turnId) {
      currentTurn = null;
      $("agent-abort").classList.add("hidden");
      setAgentConnection(false, "Stream perdido");
      addAgentSystem("⚠️ El stream se cerró sin un evento terminal; reintenta de forma explícita.");
    }
  } catch (error) {
    if (currentTurn?.turnId !== turn.turnId) return;
    currentTurn = null;
    $("agent-abort").classList.add("hidden");
    setAgentConnection(false, "Stream perdido");
    showPanelError(error, "El stream del Agent falló; reintenta de forma explícita.");
  }
}

function scrollAgentChat() {
  const messages = $("agent-messages");
  messages.scrollTop = messages.scrollHeight;
}

function addAgentMessage(role) {
  const message = document.createElement("div");
  message.className = `manager-chat-message ${role}`;
  const sender = document.createElement("div");
  sender.className = "chat-sender";
  sender.textContent = role === "user" ? "Tú" : role === "thinking" ? "Pensando" : selectedAgent?.name || "Agent";
  const content = document.createElement("div");
  content.className = `chat-content ${role === "thinking" ? "thinking" : ""}`;
  message.append(sender, content);
  $("agent-messages").appendChild(message);
  scrollAgentChat();
  return content;
}

function addAgentSystem(text) {
  const message = document.createElement("div");
  message.className = "chat-system";
  message.textContent = text;
  $("agent-messages").appendChild(message);
  scrollAgentChat();
}

const AGENT_TABS = ["chat", "resources", "autonomy"];

function switchAgentPanel(panel) {
  for (const tab of AGENT_TABS) {
    const panelEl = $(`agent-panel-${tab}`);
    const tabEl = $(`agent-tab-${tab}`);
    if (panelEl) panelEl.classList.toggle("active", tab === panel);
    if (tabEl) tabEl.classList.toggle("active", tab === panel);
  }
  if (panel === "resources") void loadAgentResources();
  if (panel === "autonomy") {
    autonomyPanel.activate();
    if (selectedAgent) autonomyPanel.selectAgent(selectedAgent.name);
  } else {
    autonomyPanel.deactivate();
  }
}

$("agent-back").addEventListener("click", () => {
  if (currentTurn) void abortCurrentTurn({ silent: true });
  selectedAgent = null;
  sessionKey = null;
  navigate("agents");
});
$("agent-tab-chat").addEventListener("click", () => switchAgentPanel("chat"));
$("agent-tab-resources").addEventListener("click", () => switchAgentPanel("resources"));
$("agent-tab-autonomy").addEventListener("click", () => switchAgentPanel("autonomy"));
$("autonomy-refresh")?.addEventListener("click", () => autonomyPanel.refresh());
function autoGrowTextarea(el) {
  el.style.height = "auto";
  const max = parseFloat(getComputedStyle(el).maxHeight) || 320;
  el.style.height = Math.min(el.scrollHeight, max) + "px";
}

// ---------- comandos del chat ----------
const CHAT_COMMANDS = [
  { cmd: "/model", args: "<proveedor/id>", desc: "Cambia el modelo y lo guarda" },
  { cmd: "/models", args: "", desc: "Lista los modelos disponibles" },
  { cmd: "/new", args: "", desc: "Empieza una sesión nueva" },
  { cmd: "/status", args: "", desc: "Estado del agente" },
  { cmd: "/stop", args: "", desc: "Aborta la respuesta en curso" },
  { cmd: "/help", args: "", desc: "Muestra los comandos disponibles" },
];

// Skills (/skill:nombre) y prompt templates (/nombre) del agente abierto — los expande pi.
let agentCommands = [];

async function loadAgentCommands() {
  agentCommands = [];
  if (!selectedAgent) return;
  try {
    const data = await panelApi.listCommands(selectedAgent.name);
    agentCommands = [
      ...(data.skills || []).map((s) => ({ cmd: `/skill:${s.name}`, args: "", desc: s.description || "skill" })),
      ...(data.prompts || []).map((p) => ({ cmd: `/${p.name}`, args: p.argumentHint || "", desc: p.description || "prompt" })),
    ];
  } catch {
    // El catálogo es una mejora de UX; un Agent puede seguir procesando el chat.
  }
}

function allChatCommands() {
  return [...CHAT_COMMANDS, ...agentCommands];
}

function hideCommandMenu() {
  $("agent-command-menu").classList.add("hidden");
}

function renderCommandMenu(prefix) {
  const matches = allChatCommands().filter((c) => c.cmd.startsWith(prefix));
  const menu = $("agent-command-menu");
  if (!matches.length) {
    hideCommandMenu();
    return;
  }
  menu.innerHTML = "";
  for (const c of matches) {
    const item = document.createElement("div");
    item.className = "command-menu-item";
    const cmd = document.createElement("span");
    cmd.className = "command-menu-cmd";
    cmd.textContent = c.args ? `${c.cmd} ${c.args}` : c.cmd;
    const desc = document.createElement("span");
    desc.className = "command-menu-desc";
    desc.textContent = c.desc;
    item.append(cmd, desc);
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      $("agent-chat-input").value = c.cmd + (c.args ? " " : "");
      hideCommandMenu();
      $("agent-chat-input").focus();
    });
    menu.appendChild(item);
  }
  menu.classList.remove("hidden");
}

function listModelsInChat() {
  const usable = modelCatalog.filter((m) => m.configured);
  if (!usable.length) {
    addAgentSystem("Sin modelos con credenciales configuradas: revisa /data/global/models.json y las API keys / OAuth.");
    return;
  }
  for (const m of usable) {
    addAgentSystem(`● ${m.provider}/${m.id} — ${m.name}`);
  }
}

async function abortCurrentTurn({ silent = false } = {}) {
  if (!currentTurn || !selectedAgent) return false;
  const turn = currentTurn;
  const agentName = selectedAgent.name;
  if (turn.abortRequested) return true;
  turn.abortRequested = true;
  try {
    await panelApi.abortTurn(agentName, turn.turnId);
    return true;
  } catch (error) {
    turn.abortRequested = false;
    if (!silent) showPanelError(error, "No se pudo cancelar el turno");
    return false;
  }
}

// Devuelve true si el comando era de la UI; false → se reenvía al agente
// (pi expande /skill:nombre, prompt templates y comandos de extensiones).
async function runChatCommand(line) {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/help":
      for (const c of allChatCommands()) addAgentSystem(`${c.cmd}${c.args ? ` ${c.args}` : ""} — ${c.desc}`);
      break;
    case "/models":
      if (!modelCatalog.length) await loadModels();
      listModelsInChat();
      break;
    case "/model":
      if (!arg) {
        addAgentSystem("Uso: /model <proveedor/id>. Disponibles:");
        if (!modelCatalog.length) await loadModels();
        listModelsInChat();
        break;
      }
      if (!selectedAgent) break;
      try {
        const updated = await panelApi.updateAgent(selectedAgent.name, { model: arg });
        selectedAgent = { ...selectedAgent, ...updated };
        setAgentModel(updated.model || arg);
        addAgentSystem(`— modelo guardado: ${updated.model || arg} —`);
      } catch (error) {
        showPanelError(error);
      }
      break;
    case "/new":
      await abortCurrentTurn({ silent: true });
      sessionKey = panelTurns.createSessionKey();
      currentTurn = null;
      currentAgentResponse = null;
      currentAgentThinking = null;
      $("agent-abort").classList.add("hidden");
      $("agent-messages").innerHTML = "";
      addAgentSystem("— sesión nueva —");
      setAgentConnection(true, "Listo");
      break;
    case "/stop":
      if (currentTurn) await abortCurrentTurn();
      else addAgentSystem("No hay una respuesta en curso.");
      break;
    case "/status": {
      if (!selectedAgent) break;
      try {
        const s = await panelApi.getAgent(selectedAgent.name);
        addAgentSystem(
          `Agente ${s.name} · ${s.state} · modelo default ${s.model || "(default)"} · en vivo ${selectedAgentModel || "(default)"} · telegram ${s.telegram ? "sí" : "no"}`,
        );
      } catch (error) {
        showPanelError(error, "No se pudo obtener el estado");
      }
      break;
    }
    default:
      return false; // no es de la UI: que lo procese pi (skills, templates, extensiones)
  }
  return true;
}

function sendToAgent(text) {
  if (!selectedAgent || !sessionKey) return;
  if (currentTurn) {
    addAgentSystem("Hay una respuesta en curso; espera a que termine o pulsa cancelar.");
    return;
  }
  const input = $("agent-chat-input");
  const content = addAgentMessage("user");
  content.textContent = text;
  input.value = "";
  currentAgentResponse = null;
  currentAgentThinking = null;
  autoGrowTextarea(input);

  const turn = panelTurns.startTurn({ agentName: selectedAgent.name, sessionKey, message: text });
  currentTurn = turn;
  void consumeTurn(turn);
}

$("agent-chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("agent-chat-input");
  const text = input.value.trim();
  if (!text) return;
  hideCommandMenu();
  if (text.startsWith("/")) {
    input.value = "";
    autoGrowTextarea(input);
    void runChatCommand(text).then((handled) => {
      if (!handled) sendToAgent(text);
    });
    return;
  }
  sendToAgent(text);
});
$("agent-chat-input").addEventListener("input", (event) => {
  autoGrowTextarea(event.target);
  const value = event.target.value;
  if (/^\/[a-z0-9:_-]*$/i.test(value)) renderCommandMenu(value);
  else hideCommandMenu();
});
$("agent-chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideCommandMenu();
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("agent-chat-form").requestSubmit();
  }
});
$("agent-chat-input").addEventListener("blur", () => setTimeout(hideCommandMenu, 150));
// ---------- adjuntos y voz (vía proxy del manager al runner) ----------
const TEXT_EXTENSIONS = /\.(txt|md|json|jsx?|tsx?|py|csv|log|ya?ml|html?|css|sh|xml|toml|ini|conf)$/i;
let agentSttOn = false;
let agentRecorder = null;
let agentRecordedChunks = [];

function setAgentSttUi(enabled) {
  agentSttOn = Boolean(enabled);
  $("agent-mic").classList.toggle("hidden", !agentSttOn);
}

function insertIntoAgentInput(text) {
  const input = $("agent-chat-input");
  input.value = input.value ? `${input.value}\n${text}` : text;
  autoGrowTextarea(input);
  input.focus();
}

async function transcribeAgentBlob(blob, filename) {
  try {
    const body = await panelApi.transcribe(selectedAgent.name, blob, filename);
    return body?.text || "";
  } catch (error) {
    showPanelError(error, "Transcripción fallida");
    return "";
  }
}

async function handleAgentAttachment(file) {
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name)) {
    const reader = new FileReader();
    reader.onload = () => insertIntoAgentInput("```" + file.name + "\n" + reader.result + "\n```\n");
    reader.readAsText(file);
    return;
  }
  if (file.type.startsWith("audio/") && agentSttOn) {
    addAgentSystem("Transcribiendo audio…");
    const text = await transcribeAgentBlob(file, file.name);
    if (text) insertIntoAgentInput(text);
    return;
  }
  addAgentSystem(`Subiendo ${file.name}…`);
  try {
    const body = await panelApi.upload(selectedAgent.name, file, file.name);
    const kb = Math.max(1, Math.round(body.size / 1024));
    insertIntoAgentInput(`[Archivo adjunto: ${body.path} — ${body.name}, ${body.type}, ${kb} KB. Léelo desde esa ruta del workspace.]`);
  } catch (error) {
    showPanelError(error, "No se pudo subir el fichero");
  }
}

async function toggleAgentRecording() {
  if (agentRecorder) {
    agentRecorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    addAgentSystem("⚠️ Sin acceso al micrófono (revisa permisos del navegador; requiere HTTPS o localhost).");
    return;
  }
  agentRecordedChunks = [];
  agentRecorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } : undefined);
  agentRecorder.ondataavailable = (event) => { if (event.data.size) agentRecordedChunks.push(event.data); };
  agentRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(agentRecordedChunks, { type: agentRecorder.mimeType || "audio/webm" });
    agentRecorder = null;
    $("agent-mic").classList.remove("recording");
    if (blob.size < 1000) return;
    addAgentSystem("Transcribiendo…");
    const text = await transcribeAgentBlob(blob, "grabacion.webm");
    if (text) insertIntoAgentInput(text);
  };
  agentRecorder.start();
  $("agent-mic").classList.add("recording");
}

$("agent-mic").addEventListener("click", () => void toggleAgentRecording());
$("agent-attach").addEventListener("click", () => $("agent-attach-input").click());
$("agent-attach-input").addEventListener("change", () => {
  const file = $("agent-attach-input").files[0];
  $("agent-attach-input").value = "";
  if (file) void handleAgentAttachment(file);
});
$("agent-abort").addEventListener("click", () => void abortCurrentTurn());

async function loadAgentResources() {
  if (!selectedAgent) return;
  try {
    const [agentPackages, agentEnv, globalPackages, globalEnv, fresh] = await Promise.all([
      panelApi.listAgentPackages(selectedAgent.name),
      panelApi.listAgentEnv(selectedAgent.name),
      panelApi.listGlobalPackages(),
      panelApi.listGlobalEnv(),
      panelApi.getAgent(selectedAgent.name),
    ]);
    selectedAgent = { ...selectedAgent, ...fresh };
    renderKeyList($("agent-packages"), agentPackages, (source) => removeAgentPackage(source, "agent"));
    renderKeyList($("agent-global-packages"), globalPackages, (source) => removeAgentPackage(source, "global"));
    renderKeyList($("agent-env"), agentEnv, (key) => removeAgentEnv(key, "agent"), "••••••");
    renderKeyList($("agent-global-env"), globalEnv, (key) => removeAgentEnv(key, "global"), "••••••");
    renderTelegramCard();
    renderVoiceCard();
  } catch (error) {
    showPanelError(error, "No se pudieron cargar los recursos");
  }
}

function renderTelegramCard() {
  const configured = Boolean(selectedAgent?.telegram);
  $("agent-telegram-chip").classList.toggle("chip-ok", configured);
  $("agent-telegram-chip-text").textContent = configured ? "Configurado" : "Sin configurar";
  $("agent-telegram-remove").classList.toggle("hidden", !configured);
  $("agent-telegram-token").value = "";
}

function renderVoiceCard() {
  const voice = selectedAgent?.ttsVoice || "";
  $("agent-voice-chip").classList.toggle("chip-ok", Boolean(voice));
  $("agent-voice-chip-text").textContent = voice || "Voz global";
  $("agent-voice-remove").classList.toggle("hidden", !voice);
  $("agent-voice-input").value = voice;
}

async function removeAgentPackage(source, scope) {
  try {
    if (scope === "agent") await panelApi.removeAgentPackage(selectedAgent.name, source);
    else await panelApi.removeGlobalPackage(source);
    setTimeout(loadAgentResources, 800);
  } catch (error) {
    showPanelError(error, "No se pudo quitar el paquete");
  }
}

async function removeAgentEnv(key, scope) {
  try {
    if (scope === "agent") await panelApi.removeAgentEnv(selectedAgent.name, key);
    else await panelApi.removeGlobalEnv(key);
    setTimeout(loadAgentResources, 800);
  } catch (error) {
    showPanelError(error, "No se pudo quitar la variable");
  }
}

$("agent-package-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const source = $("agent-package-source").value.trim();
  if (!source || !selectedAgent) return;
  const scope = document.querySelector('input[name="agent-package-scope"]:checked').value;
  $("agent-package-status").textContent = "Instalando…";
  try {
    if (scope === "agent") await panelApi.installAgentPackage(selectedAgent.name, source);
    else await panelApi.installGlobalPackage(source);
    $("agent-package-status").textContent = "Instalado ✔ · reiniciando Agent…";
    $("agent-package-source").value = "";
    setTimeout(loadAgentResources, 1000);
  } catch (error) {
    $("agent-package-status").textContent = `Error: ${panelErrorMessage(error)}`;
  }
});

$("agent-env-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = $("agent-env-key").value.trim();
  if (!key || !selectedAgent) return;
  const scope = document.querySelector('input[name="agent-env-scope"]:checked').value;
  try {
    if (scope === "agent") await panelApi.setAgentEnv(selectedAgent.name, key, $("agent-env-value").value);
    else await panelApi.setGlobalEnv(key, $("agent-env-value").value);
    $("agent-env-status").textContent = "Guardado ✔ · reiniciando Agent…";
    $("agent-env-key").value = "";
    $("agent-env-value").value = "";
    setTimeout(loadAgentResources, 1000);
  } catch (error) {
    $("agent-env-status").textContent = `Error: ${panelErrorMessage(error)}`;
  }
});

$("agent-telegram-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = $("agent-telegram-token").value.trim();
  if (!token || !selectedAgent) return;
  $("agent-telegram-status").textContent = "Guardando…";
  try {
    await panelApi.updateAgent(selectedAgent.name, { telegramToken: token });
    $("agent-telegram-status").textContent = "Guardado ✔ · reiniciando Agent…";
    setTimeout(loadAgentResources, 1500);
  } catch (error) {
    $("agent-telegram-status").textContent = `Error: ${panelErrorMessage(error)}`;
  }
});

$("agent-telegram-remove").addEventListener("click", async () => {
  if (!selectedAgent) return;
  if (!confirm(`¿Quitar el bot de Telegram de "${selectedAgent.name}"?`)) return;
  $("agent-telegram-status").textContent = "Quitando…";
  try {
    await panelApi.updateAgent(selectedAgent.name, { telegramToken: null });
    $("agent-telegram-status").textContent = "Bot quitado ✔ · reiniciando Agent…";
    setTimeout(loadAgentResources, 1500);
  } catch (error) {
    $("agent-telegram-status").textContent = `Error: ${panelErrorMessage(error)}`;
  }
});

$("agent-voice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const voice = $("agent-voice-input").value.trim();
  if (!voice || !selectedAgent) return;
  $("agent-voice-status").textContent = "Guardando…";
  try {
    await panelApi.updateAgent(selectedAgent.name, { ttsVoice: voice });
    $("agent-voice-status").textContent = "Guardada ✔ · reiniciando Agent…";
    setTimeout(loadAgentResources, 1500);
  } catch (error) {
    $("agent-voice-status").textContent = `Error: ${panelErrorMessage(error)}`;
  }
});

$("agent-voice-remove").addEventListener("click", async () => {
  if (!selectedAgent) return;
  $("agent-voice-status").textContent = "Quitando…";
  try {
    await panelApi.updateAgent(selectedAgent.name, { ttsVoice: null });
    $("agent-voice-status").textContent = "Voz global ✔ · reiniciando Agent…";
    setTimeout(loadAgentResources, 1500);
  } catch (error) {
    $("agent-voice-status").textContent = `Error: ${panelErrorMessage(error)}`;
  }
});

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("create-error").textContent = "";
  const packages = $("new-packages").value.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    await panelApi.createAgent({
      name: $("new-name").value.trim(),
      model:
        ($("new-model-select").classList.contains("hidden")
          ? $("new-model").value
          : $("new-model-select").value
        ).trim() || undefined,
      telegramToken: $("new-telegram").value.trim() || undefined,
      systemPrompt: $("new-system").value.trim() || undefined,
      packages: packages.length ? packages : undefined,
    });
    $("create-form").reset();
    $("create-agent").open = false;
    await loadAgents();
  } catch (error) {
    $("create-error").textContent = panelErrorMessage(error, "Error al crear el Agent");
  }
});

// ---------- listas reutilizables ----------
function renderKeyList(el, items, onRemove, sub) {
  el.innerHTML = "";
  if (!items.length) {
    const row = document.createElement("div");
    row.className = "list-item";
    const c = document.createElement("div");
    c.className = "list-item-sub";
    c.textContent = "— vacío —";
    row.appendChild(c);
    el.appendChild(row);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "list-item";
    const content = document.createElement("div");
    content.className = "list-item-content";
    const title = document.createElement("div");
    title.className = "list-item-title";
    title.style.fontFamily = "var(--font-mono)";
    title.style.fontSize = "var(--text-small)";
    title.textContent = item;
    content.appendChild(title);
    if (sub) {
      const s = document.createElement("div");
      s.className = "list-item-sub";
      s.textContent = sub;
      content.appendChild(s);
    }
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost btn-sm";
    btn.style.color = "var(--danger)";
    btn.textContent = "Quitar";
    btn.onclick = async () => {
      btn.disabled = true;
      await onRemove(item);
    };
    row.append(content, btn);
    el.appendChild(row);
  }
}

// ---------- paquetes globales ----------
async function loadGlobalPackages() {
  try {
    const packages = await panelApi.listGlobalPackages();
    renderKeyList($("global-packages"), packages, async (source) => {
      try {
        await panelApi.removeGlobalPackage(source);
        setTimeout(loadGlobalPackages, 800);
      } catch (error) {
        showPanelError(error, "No se pudo quitar el paquete");
      }
    });
  } catch (error) {
    showPanelError(error, "No se pudieron cargar los paquetes");
  }
}

$("install-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const source = $("install-source").value.trim();
  if (!source) return;
  $("install-status").textContent = "Instalando…";
  try {
    await panelApi.installGlobalPackage(source);
    $("install-status").textContent = "Instalado ✔ (agentes reiniciándose…)";
    $("install-source").value = "";
    setTimeout(loadGlobalPackages, 1000);
  } catch (error) {
    $("install-status").textContent = `Error: ${panelErrorMessage(error)}`;
  }
});

// ---------- variables de entorno globales ----------
async function loadGlobalEnv() {
  try {
    const keys = await panelApi.listGlobalEnv();
    renderKeyList($("global-env"), keys, async (key) => {
      try {
        await panelApi.removeGlobalEnv(key);
        setTimeout(loadGlobalEnv, 800);
      } catch (error) {
        showPanelError(error, "No se pudo quitar la variable");
      }
    }, "••••••");
  } catch (error) {
    showPanelError(error, "No se pudieron cargar las variables");
  }
}

$("env-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("env-key").value.trim();
  if (!key) return;
  const value = $("env-value").value;
  $("env-status").textContent = "Guardando…";
  try {
    await panelApi.setGlobalEnv(key, value);
    $("env-status").textContent = "Guardado ✔ (agentes reiniciándose…)";
    $("env-key").value = "";
    $("env-value").value = "";
    setTimeout(loadGlobalEnv, 1000);
  } catch (error) {
    $("env-status").textContent = `Error: ${panelErrorMessage(error)}`;
  }
});

// ---------- OAuth ----------
let pollTimer = null;

async function loadProviders() {
  try {
    const { providers } = await panelApi.oauth.providers();
    if (!providers.length) return;
    $("nav-oauth").classList.remove("hidden");
    const wrap = $("oauth-list");
    wrap.innerHTML = "";
    for (const p of providers) {
      const card = document.createElement("div");
      card.className = "card";
      const header = document.createElement("div");
      header.className = "card-header";
      const title = document.createElement("span");
      title.className = "card-title";
      title.textContent = p.name;
      const chip = document.createElement("span");
      chip.className = `chip ${p.loggedIn ? "chip-ok" : "chip-danger"}`;
      chip.innerHTML = '<span class="chip-dot"></span>';
      chip.append(p.loggedIn ? " Conectado" : " Desconectado");
      header.append(title, chip);

      const btn = document.createElement("button");
      btn.className = `btn btn-sm ${p.loggedIn ? "btn-secondary" : "btn-primary"}`;
      btn.textContent = p.loggedIn ? "Desconectar" : "Conectar";
      btn.onclick = async () => {
        try {
          if (p.loggedIn) {
            await panelApi.oauth.logout(p.id);
            await loadProviders();
          } else {
            const flow = await panelApi.oauth.startLogin(p.id);
            if (flow.error) return alert(flow.error);
            pollFlow(flow.id);
          }
        } catch (error) {
          $("oauth-msg").textContent = `⚠️ ${panelErrorMessage(error)}`;
        }
      };
      card.append(header, btn);
      wrap.appendChild(card);
    }
  } catch (error) {
    if (error instanceof PanelApiError && error.requiresLogin) showLogin();
  }
}

function renderFlow(flow) {
  $("oauth-flow").classList.remove("hidden");
  $("oauth-msg").textContent = flow.progress || flow.message || flow.phase;
  const link = $("oauth-url");
  if (flow.url) {
    link.href = flow.url;
    link.textContent = `Abrir autorización de ${flow.provider} ↗`;
    link.classList.remove("hidden");
  } else link.classList.add("hidden");
  $("oauth-code").textContent = flow.userCode ? `Código a introducir: ${flow.userCode}` : "";
  $("oauth-input-form").classList.toggle("hidden", flow.phase !== "input");

  const sel = $("oauth-select");
  sel.classList.toggle("hidden", flow.phase !== "select");
  if (flow.phase === "select" && flow.options) {
    sel.innerHTML = "";
    for (const opt of flow.options) {
      const b = document.createElement("button");
      b.className = "btn btn-secondary btn-sm";
      b.textContent = opt.label;
      b.onclick = () => submitFlow(flow.id, opt.id);
      sel.appendChild(b);
    }
  }

  if (flow.phase === "done") {
    $("oauth-msg").textContent = "✔ Conectado";
    clearInterval(pollTimer);
    setTimeout(() => { $("oauth-flow").classList.add("hidden"); loadProviders(); }, 1500);
  } else if (flow.phase === "error") {
    $("oauth-msg").textContent = `⚠️ ${flow.error}`;
    clearInterval(pollTimer);
  }
}

function pollFlow(id) {
  clearInterval(pollTimer);
  $("oauth-input-form").onsubmit = (e) => {
    e.preventDefault();
    void submitFlow(id, $("oauth-input").value.trim());
    $("oauth-input").value = "";
  };
  pollTimer = setInterval(async () => {
    try {
      renderFlow(await panelApi.oauth.getFlow(id));
    } catch (error) {
      $("oauth-msg").textContent = `⚠️ ${panelErrorMessage(error)}`;
    }
  }, 1200);
}

async function submitFlow(id, value) {
  try {
    await panelApi.oauth.submitFlowInput(id, value);
  } catch (error) {
    $("oauth-msg").textContent = `⚠️ ${panelErrorMessage(error)}`;
  }
}

// ---------- init ----------
async function init() {
  const csrfToken = csrfCookieValue();
  panelApi.setCsrfToken(csrfToken);
  panelTurns.setCsrfToken(csrfToken);
  try {
    const status = await panelApi.status();
    $("status-line").textContent = `pi ${status.pi} · ${status.agents} agentes`;
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    navigate("agents");
    void loadAgents();
    void loadModels();
    void loadGlobalPackages();
    void loadGlobalEnv();
    void loadProviders();
    setInterval(() => void loadAgents(), 10000);

    // Autonomía: badge cada 30s con los agentes conocidos
    function scheduleBadgeRefresh() {
      const agentNames = Array.from(document.querySelectorAll(".card-title")).map((el) => el.textContent).filter(Boolean);
      if (agentNames.length) autonomyPanel.startBadgeTimer(agentNames);
    }
    // Primer badge tras cargar agentes
    setTimeout(scheduleBadgeRefresh, 500);
    // También en cada ciclo de loadAgents
    const origLoadAgents = loadAgents;
    window.__autonomyBadgeRefresh = scheduleBadgeRefresh;

    // Visibility / focus para polling de autonomía
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const active = document.querySelector(".agent-tab.active");
        if (active?.id === "agent-tab-autonomy") void autonomyPanel.refresh();
      }
    });
    window.addEventListener("focus", () => {
      const active = document.querySelector(".agent-tab.active");
      if (active?.id === "agent-tab-autonomy") void autonomyPanel.refresh();
    });
  } catch (error) {
    if (error instanceof PanelApiError && error.requiresLogin) showLogin();
  }
}

init();
