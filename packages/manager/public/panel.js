/* pihub — panel del manager (vanilla JS, sin build) */
import { agentSocketUrl, agentPackagesUrl, agentEnvUrl } from "/agent-channel.js";
import { renderMarkdown } from "/markdown.js";

const $ = (id) => document.getElementById(id);
let selectedAgent = null;
let agentSocket = null;
let agentReconnectTimer = null;
let currentAgentResponse = null;
let currentAgentThinking = null;

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

// ---------- navigation ----------
function navigate(screen) {
  if (screen !== "agent" && agentSocket) closeAgentSocket();
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

// ---------- api ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("no autorizado");
  }
  return res;
}

function showLogin() {
  $("login").classList.remove("hidden");
  $("app").classList.add("hidden");
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: $("token-input").value }),
  });
  if (res.ok) init();
  else $("login-error").textContent = "Token incorrecto";
});

// ---------- agentes ----------
const STATE_CHIP = {
  running: { cls: "chip-ok", label: "Ejecutando" },
  errored: { cls: "chip-danger", label: "Error" },
  stopped: { cls: "", label: "Detenido" },
};

async function loadAgents() {
  const res = await api("/api/agents");
  const agents = await res.json();
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
    meta.textContent = `:${agent.port} · ${agent.model || "modelo por defecto"}${agent.telegram ? " · ✈ telegram" : ""}`;

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
      await api(`/api/agents/${agent.name}/${running ? "stop" : "start"}`, { method: "POST" });
      loadAgents();
    };

    const restart = document.createElement("button");
    restart.className = "btn btn-secondary btn-sm";
    restart.textContent = "Reiniciar";
    restart.onclick = async () => {
      restart.disabled = true;
      await api(`/api/agents/${agent.name}/restart`, { method: "POST" });
      loadAgents();
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
      await api(`/api/agents/${agent.name}`, { method: "DELETE" });
      loadAgents();
    };

    actions.append(primary, restart, chat, del);
    card.append(conversation, actions);
    wrap.appendChild(card);
  }
}

// ---------- Modelos disponibles ----------
let modelCatalog = [];
let selectedAgentModel = "";

async function loadModels() {
  const response = await api("/api/models").catch(() => null);
  if (!response?.ok) return;
  modelCatalog = (await response.json()).models || [];
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
  setAgentModel(agent.model || "");
  $("selected-agent-name").textContent = agent.name;
  $("agent-messages").innerHTML = "";
  switchAgentPanel("chat");
  navigate("agent");
  connectAgent();
  void loadAgentCommands();
}

function closeAgentSocket() {
  clearTimeout(agentReconnectTimer);
  agentReconnectTimer = null;
  if (agentSocket) {
    agentSocket.onclose = null;
    agentSocket.close();
    agentSocket = null;
  }
  setAgentConnection(false);
}

function setAgentConnection(connected) {
  $("agent-connection").classList.toggle("chip-ok", connected);
  $("agent-connection-text").textContent = connected ? "Conectado" : "Desconectado";
}

function connectAgent() {
  closeAgentSocket();
  if (!selectedAgent) return;
  const activeAgent = selectedAgent.name;
  agentSocket = new WebSocket(agentSocketUrl(location, selectedAgent));
  agentSocket.onopen = () => setAgentConnection(true);
  agentSocket.onmessage = (event) => handleAgentMessage(JSON.parse(event.data));
  agentSocket.onclose = () => {
    setAgentConnection(false);
    if (selectedAgent?.name === activeAgent && $("screen-agent").classList.contains("active")) {
      agentReconnectTimer = setTimeout(connectAgent, 2000);
    }
  };
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

function handleAgentMessage(message) {
  switch (message.type) {
    case "agent_start":
      $("agent-abort").classList.remove("hidden");
      break;
    case "agent_end":
      $("agent-abort").classList.add("hidden");
      currentAgentResponse?.classList.remove("streaming");
      currentAgentResponse = null;
      currentAgentThinking = null;
      break;
    case "text_delta":
      if (!currentAgentResponse) {
        currentAgentResponse = addAgentMessage("assistant");
        currentAgentResponse.classList.add("streaming");
      }
      currentAgentResponse.markdownSource = (currentAgentResponse.markdownSource || "") + message.delta;
      scheduleAgentMarkdownRender(currentAgentResponse);
      break;
    case "thinking_delta":
      if (!currentAgentThinking) currentAgentThinking = addAgentMessage("thinking");
      currentAgentThinking.textContent += message.delta;
      scrollAgentChat();
      break;
    case "tool_start":
      addAgentSystem(`Ejecutando ${message.toolName}…`);
      currentAgentResponse?.classList.remove("streaming");
      currentAgentResponse = null;
      break;
    case "session_new":
      $("agent-messages").innerHTML = "";
      addAgentSystem("— sesión nueva —");
      break;
    case "ready":
      if (message.model) setAgentModel(message.model);
      if (message.stt !== undefined) setAgentSttUi(message.stt);
      break;
    case "model_changed":
      setAgentModel(message.model);
      addAgentSystem(`— modelo cambiado a ${message.model} —`);
      break;
    case "error":
      addAgentSystem(`⚠️ ${message.message}`);
      break;
  }
}

function switchAgentPanel(panel) {
  $("agent-panel-chat").classList.toggle("active", panel === "chat");
  $("agent-panel-resources").classList.toggle("active", panel === "resources");
  $("agent-tab-chat").classList.toggle("active", panel === "chat");
  $("agent-tab-resources").classList.toggle("active", panel === "resources");
  if (panel === "resources") void loadAgentResources();
}

$("agent-back").addEventListener("click", () => {
  closeAgentSocket();
  selectedAgent = null;
  navigate("agents");
});
$("agent-tab-chat").addEventListener("click", () => switchAgentPanel("chat"));
$("agent-tab-resources").addEventListener("click", () => switchAgentPanel("resources"));
function autoGrowTextarea(el) {
  el.style.height = "auto";
  const max = parseFloat(getComputedStyle(el).maxHeight) || 320;
  el.style.height = Math.min(el.scrollHeight, max) + "px";
}

// ---------- comandos del chat ----------
const CHAT_COMMANDS = [
  { cmd: "/model", args: "<proveedor/id>", desc: "Cambia el modelo en vivo (no persiste)" },
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
  const response = await api(`/api/agents/${selectedAgent.name}/commands`).catch(() => null);
  if (!response?.ok) return;
  const data = await response.json();
  agentCommands = [
    ...(data.skills || []).map((s) => ({ cmd: `/skill:${s.name}`, args: "", desc: s.description || "skill" })),
    ...(data.prompts || []).map((p) => ({ cmd: `/${p.name}`, args: p.argumentHint || "", desc: p.description || "prompt" })),
  ];
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
      if (agentSocket?.readyState === WebSocket.OPEN) {
        agentSocket.send(JSON.stringify({ type: "set_model", model: arg }));
      }
      break;
    case "/new":
      if (agentSocket?.readyState === WebSocket.OPEN) agentSocket.send(JSON.stringify({ type: "new_session" }));
      break;
    case "/stop":
      if (agentSocket?.readyState === WebSocket.OPEN) agentSocket.send(JSON.stringify({ type: "abort" }));
      break;
    case "/status": {
      if (!selectedAgent) break;
      const response = await api(`/api/agents/${selectedAgent.name}`).catch(() => null);
      if (!response?.ok) {
        addAgentSystem("⚠️ No se pudo obtener el estado");
        break;
      }
      const s = await response.json();
      addAgentSystem(
        `Agente ${s.name} · ${s.state} · modelo default ${s.model || "(default)"} · en vivo ${selectedAgentModel || "(default)"} · telegram ${s.telegram ? "sí" : "no"}`,
      );
      break;
    }
    default:
      return false; // no es de la UI: que lo procese pi (skills, templates, extensiones)
  }
  return true;
}

function sendToAgent(text) {
  if (agentSocket?.readyState !== WebSocket.OPEN) return;
  const input = $("agent-chat-input");
  const content = addAgentMessage("user");
  content.textContent = text;
  agentSocket.send(JSON.stringify({ type: "prompt", text }));
  input.value = "";
  currentAgentResponse = null;
  currentAgentThinking = null;
  autoGrowTextarea(input);
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
  const form = new FormData();
  form.append("file", blob, filename);
  const response = await fetch(`/api/agents/${selectedAgent.name}/transcribe`, {
    method: "POST",
    body: form,
  }).catch(() => null);
  const body = await response?.json().catch(() => ({}));
  if (!response?.ok) {
    addAgentSystem(`⚠️ Transcripción fallida: ${body?.error || response?.status || "error de red"}`);
    return "";
  }
  return body.text || "";
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
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch(`/api/agents/${selectedAgent.name}/upload`, {
    method: "POST",
    body: form,
  }).catch(() => null);
  const body = await response?.json().catch(() => ({}));
  if (!response?.ok) {
    addAgentSystem(`⚠️ No se pudo subir: ${body?.error || response?.status || "error de red"}`);
    return;
  }
  const kb = Math.max(1, Math.round(body.size / 1024));
  insertIntoAgentInput(`[Archivo adjunto: ${body.path} — ${body.name}, ${body.type}, ${kb} KB. Léelo desde esa ruta del workspace.]`);
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
$("agent-abort").addEventListener("click", () => agentSocket?.send(JSON.stringify({ type: "abort" })));

async function loadAgentResources() {
  if (!selectedAgent) return;
  const [packageResponse, envResponse, globalPackageResponse, agentResponse] = await Promise.all([
    api(agentPackagesUrl(selectedAgent.name)),
    api(agentEnvUrl(selectedAgent.name)),
    api("/api/packages"),
    api(`/api/agents/${selectedAgent.name}`),
  ]);
  const agentPackages = (await packageResponse.json()).packages;
  const env = await envResponse.json();
  const globalPackages = (await globalPackageResponse.json()).packages;
  if (agentResponse.ok) {
    const fresh = await agentResponse.json();
    selectedAgent = { ...selectedAgent, ...fresh };
  }
  renderKeyList($("agent-packages"), agentPackages, (source) => removeAgentPackage(source, "agent"));
  renderKeyList($("agent-global-packages"), globalPackages, (source) => removeAgentPackage(source, "global"));
  renderKeyList($("agent-env"), env.agent || [], (key) => removeAgentEnv(key, "agent"), "••••••");
  renderKeyList($("agent-global-env"), env.global || [], (key) => removeAgentEnv(key, "global"), "••••••");
  renderTelegramCard();
  renderVoiceCard();
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
  await api("/api/packages", {
    method: "DELETE",
    body: JSON.stringify({ source, scope, ...(scope === "agent" ? { agent: selectedAgent.name } : {}) }),
  });
  setTimeout(loadAgentResources, 800);
}

async function removeAgentEnv(key, scope) {
  await api("/api/env", {
    method: "DELETE",
    body: JSON.stringify({ key, scope, ...(scope === "agent" ? { agent: selectedAgent.name } : {}) }),
  });
  setTimeout(loadAgentResources, 800);
}

$("agent-package-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const source = $("agent-package-source").value.trim();
  if (!source || !selectedAgent) return;
  const scope = document.querySelector('input[name="agent-package-scope"]:checked').value;
  $("agent-package-status").textContent = "Instalando…";
  const response = await api("/api/packages", {
    method: "POST",
    body: JSON.stringify({ source, scope, ...(scope === "agent" ? { agent: selectedAgent.name } : {}) }),
  });
  const body = await response.json().catch(() => ({}));
  $("agent-package-status").textContent = response.ok ? "Instalado ✔ · reiniciando Agent…" : `Error: ${body.error || response.status}`;
  if (response.ok) $("agent-package-source").value = "";
  setTimeout(loadAgentResources, 1000);
});

$("agent-env-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = $("agent-env-key").value.trim();
  if (!key || !selectedAgent) return;
  const scope = document.querySelector('input[name="agent-env-scope"]:checked').value;
  const response = await api("/api/env", {
    method: "POST",
    body: JSON.stringify({ key, value: $("agent-env-value").value, scope, ...(scope === "agent" ? { agent: selectedAgent.name } : {}) }),
  });
  const body = await response.json().catch(() => ({}));
  $("agent-env-status").textContent = response.ok ? "Guardado ✔ · reiniciando Agent…" : `Error: ${body.error || response.status}`;
  if (response.ok) {
    $("agent-env-key").value = "";
    $("agent-env-value").value = "";
  }
  setTimeout(loadAgentResources, 1000);
});

$("agent-telegram-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = $("agent-telegram-token").value.trim();
  if (!token || !selectedAgent) return;
  $("agent-telegram-status").textContent = "Guardando…";
  const response = await api(`/api/agents/${selectedAgent.name}`, {
    method: "PATCH",
    body: JSON.stringify({ telegramToken: token }),
  });
  const body = await response.json().catch(() => ({}));
  $("agent-telegram-status").textContent = response.ok
    ? "Guardado ✔ · reiniciando Agent…"
    : `Error: ${body.error || response.status}`;
  setTimeout(loadAgentResources, 1500);
});

$("agent-telegram-remove").addEventListener("click", async () => {
  if (!selectedAgent) return;
  if (!confirm(`¿Quitar el bot de Telegram de "${selectedAgent.name}"?`)) return;
  $("agent-telegram-status").textContent = "Quitando…";
  const response = await api(`/api/agents/${selectedAgent.name}`, {
    method: "PATCH",
    body: JSON.stringify({ telegramToken: null }),
  });
  const body = await response.json().catch(() => ({}));
  $("agent-telegram-status").textContent = response.ok
    ? "Bot quitado ✔ · reiniciando Agent…"
    : `Error: ${body.error || response.status}`;
  setTimeout(loadAgentResources, 1500);
});

$("agent-voice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const voice = $("agent-voice-input").value.trim();
  if (!voice || !selectedAgent) return;
  $("agent-voice-status").textContent = "Guardando…";
  const response = await api(`/api/agents/${selectedAgent.name}`, {
    method: "PATCH",
    body: JSON.stringify({ ttsVoice: voice }),
  });
  const body = await response.json().catch(() => ({}));
  $("agent-voice-status").textContent = response.ok
    ? "Guardada ✔ · reiniciando Agent…"
    : `Error: ${body.error || response.status}`;
  setTimeout(loadAgentResources, 1500);
});

$("agent-voice-remove").addEventListener("click", async () => {
  if (!selectedAgent) return;
  $("agent-voice-status").textContent = "Quitando…";
  const response = await api(`/api/agents/${selectedAgent.name}`, {
    method: "PATCH",
    body: JSON.stringify({ ttsVoice: null }),
  });
  const body = await response.json().catch(() => ({}));
  $("agent-voice-status").textContent = response.ok
    ? "Voz global ✔ · reiniciando Agent…"
    : `Error: ${body.error || response.status}`;
  setTimeout(loadAgentResources, 1500);
});

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("create-error").textContent = "";
  const packages = $("new-packages").value.split(",").map((s) => s.trim()).filter(Boolean);
  const res = await api("/api/agents", {
    method: "POST",
    body: JSON.stringify({
      name: $("new-name").value.trim(),
      model:
        ($("new-model-select").classList.contains("hidden")
          ? $("new-model").value
          : $("new-model-select").value
        ).trim() || undefined,
      telegramToken: $("new-telegram").value.trim() || undefined,
      systemPrompt: $("new-system").value.trim() || undefined,
      packages: packages.length ? packages : undefined,
    }),
  });
  if (res.ok) {
    $("create-form").reset();
    $("create-agent").open = false;
    loadAgents();
  } else {
    $("create-error").textContent = (await res.json()).error || "Error";
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
  const res = await api("/api/packages");
  const { packages } = await res.json();
  renderKeyList($("global-packages"), packages, async (source) => {
    await api("/api/packages", { method: "DELETE", body: JSON.stringify({ source, scope: "global" }) });
    setTimeout(loadGlobalPackages, 800);
  });
}

$("install-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const source = $("install-source").value.trim();
  if (!source) return;
  $("install-status").textContent = "Instalando…";
  const res = await api("/api/packages", {
    method: "POST",
    body: JSON.stringify({ source, scope: "global" }),
  });
  const body = await res.json().catch(() => ({}));
  $("install-status").textContent = res.ok ? "Instalado ✔ (agentes reiniciándose…)" : `Error: ${body.error || res.status}`;
  $("install-source").value = "";
  setTimeout(loadGlobalPackages, 1000);
});

// ---------- variables de entorno globales ----------
async function loadGlobalEnv() {
  const res = await api("/api/env");
  const { global } = await res.json();
  renderKeyList($("global-env"), global, async (key) => {
    await api("/api/env", { method: "DELETE", body: JSON.stringify({ key, scope: "global" }) });
    setTimeout(loadGlobalEnv, 800);
  }, "••••••");
}

$("env-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("env-key").value.trim();
  if (!key) return;
  const value = $("env-value").value;
  $("env-status").textContent = "Guardando…";
  const res = await api("/api/env", {
    method: "POST",
    body: JSON.stringify({ key, value, scope: "global" }),
  });
  const body = await res.json().catch(() => ({}));
  $("env-status").textContent = res.ok ? "Guardado ✔ (agentes reiniciándose…)" : `Error: ${body.error || res.status}`;
  $("env-key").value = "";
  $("env-value").value = "";
  setTimeout(loadGlobalEnv, 1000);
});

// ---------- OAuth ----------
let pollTimer = null;

async function loadProviders() {
  const res = await api("/api/auth/providers");
  const { providers } = await res.json();
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
      if (p.loggedIn) {
        await api(`/api/auth/logout/${p.id}`, { method: "POST" });
        loadProviders();
      } else {
        const r = await api(`/api/auth/login/${p.id}`, { method: "POST" });
        const flow = await r.json();
        if (flow.error) return alert(flow.error);
        pollFlow(flow.id);
      }
    };
    card.append(header, btn);
    wrap.appendChild(card);
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
    submitFlow(id, $("oauth-input").value.trim());
    $("oauth-input").value = "";
  };
  pollTimer = setInterval(async () => {
    const res = await api(`/api/auth/flows/${id}`);
    if (res.ok) renderFlow(await res.json());
  }, 1200);
}

async function submitFlow(id, value) {
  await api(`/api/auth/flows/${id}/input`, { method: "POST", body: JSON.stringify({ value }) });
}

// ---------- init ----------
async function init() {
  try {
    const res = await api("/api/status");
    const status = await res.json();
    $("status-line").textContent = `pi ${status.pi} · ${status.agents} agente(s) · puertos ${status.portRange[0]}-${status.portRange[1]}`;
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    navigate("agents");
    loadAgents();
    loadModels();
    loadGlobalPackages();
    loadGlobalEnv();
    loadProviders();
    setInterval(loadAgents, 10000);
  } catch {
    /* login mostrado */
  }
}

init();
