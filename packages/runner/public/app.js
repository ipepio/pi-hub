/* pihub — chat UI del agente (vanilla JS, sin build) */
import { renderMarkdown } from "/markdown.js";

const $ = (id) => document.getElementById(id);

let ws = null;
let currentAssistant = null;
let currentThinking = null;

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
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(`screen-${screen}`)?.classList.add("active");
  document.querySelectorAll(".sidebar-link").forEach((l) =>
    l.classList.toggle("active", l.dataset.screen === screen),
  );
  closeSidebar();
  if (screen === "resources") {
    void loadResources();
    void loadEnv();
  }
}
$("tab-chat").addEventListener("click", () => navigate("chat"));
$("tab-resources").addEventListener("click", () => navigate("resources"));

// ---------- auth ----------
async function checkAuth() {
  const res = await fetch("/api/status");
  if (res.status === 401) {
    $("login").classList.remove("hidden");
    $("app").classList.add("hidden");
    return false;
  }
  const status = await res.json();
  $("agent-name").textContent = status.agent;
  $("model-name").textContent = status.model || "";
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  setSttUi(status.stt);
  void loadModels();
  void loadAgentCommands();
  return true;
}

// ---------- modelos ----------
let currentModel = "";
let modelCatalog = [];

async function loadModels() {
  const res = await fetch("/api/models");
  if (!res.ok) return;
  const data = await res.json();
  modelCatalog = data.models || [];
  if (!currentModel && data.current) setCurrentModel(data.current);
}

function setCurrentModel(model) {
  currentModel = model || "";
  $("model-name").textContent = currentModel;
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: $("token-input").value }),
  });
  if (res.ok) {
    if (await checkAuth()) connect();
  } else {
    $("login-error").textContent = "Token incorrecto";
  }
});

// ---------- websocket ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    $("conn").classList.add("ok");
    $("conn-text").textContent = "Conectado";
  };
  ws.onclose = () => {
    $("conn").classList.remove("ok");
    $("conn-text").textContent = "Desconectado";
    setTimeout(() => { if (document.visibilityState !== "hidden") connect(); }, 2000);
  };
  ws.onmessage = (event) => handle(JSON.parse(event.data));
}

// ---------- chat rendering ----------
function scrollDown() {
  const m = $("messages");
  m.scrollTop = m.scrollHeight;
}

function addSystem(text) {
  const div = document.createElement("div");
  div.className = "chat-system";
  div.textContent = text;
  $("messages").appendChild(div);
  scrollDown();
  return div;
}

// role: "user" | "assistant" | "thinking" -> returns the .chat-content element
function addBubble(role) {
  const wrap = document.createElement("div");
  wrap.className = "chat-message";

  const avatar = document.createElement("div");
  avatar.className = "chat-avatar " + (role === "user" ? "chat-avatar-user" : "chat-avatar-agent");
  avatar.textContent = role === "user" ? "U" : "A";

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";

  const sender = document.createElement("div");
  sender.className = "chat-sender";
  sender.textContent = role === "user" ? "Tú" : "Agente";

  const content = document.createElement("div");
  content.className = "chat-content";
  if (role === "thinking") content.classList.add("thinking");

  bubble.append(sender, content);
  wrap.append(avatar, bubble);
  $("messages").appendChild(wrap);
  scrollDown();
  return content;
}

const TOOL_ICONS = {
  running: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 2v4l2.5 1.5"/></svg>',
  ok: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5l2.5 2.5 4.5-5"/></svg>',
  error: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 3l6 6m0-6l-6 6"/></svg>',
};

function setToolChip(chip, state, label) {
  chip.className = `tool-chip tool-chip-${state}`;
  chip.innerHTML = `<span class="tool-chip-icon">${TOOL_ICONS[state]}</span><span></span>`;
  chip.lastChild.textContent = label;
}

function addToolChip(name) {
  const row = document.createElement("div");
  row.className = "chat-tool-chips";
  row.style.paddingLeft = "44px";
  const chip = document.createElement("span");
  setToolChip(chip, "running", `${name}…`);
  row.appendChild(chip);
  $("messages").appendChild(row);
  scrollDown();
  return chip;
}

const toolChips = new Map();

// Re-parsing the whole accumulated response through renderMarkdown on every
// single delta is O(n^2) over a response and freezes the tab on long
// replies. Coalesce to at most one render per animation frame instead.
let pendingRenderEl = null;
let renderScheduled = false;
function scheduleMarkdownRender(el) {
  pendingRenderEl = el;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (pendingRenderEl) {
      pendingRenderEl.innerHTML = renderMarkdown(pendingRenderEl.markdownSource);
      pendingRenderEl = null;
      scrollDown();
    }
  });
}

function handle(msg) {
  switch (msg.type) {
    case "ready":
      $("agent-name").textContent = msg.agent;
      if (msg.model) setCurrentModel(msg.model);
      if (msg.stt !== undefined) setSttUi(msg.stt);
      break;
    case "agent_start":
      $("abort").classList.remove("hidden");
      break;
    case "agent_end":
      $("abort").classList.add("hidden");
      if (currentAssistant) currentAssistant.classList.remove("streaming");
      currentAssistant = null;
      currentThinking = null;
      break;
    case "text_delta":
      if (!currentAssistant) {
        currentAssistant = addBubble("assistant");
        currentAssistant.classList.add("streaming");
      }
      currentAssistant.markdownSource = (currentAssistant.markdownSource || "") + msg.delta;
      scheduleMarkdownRender(currentAssistant);
      break;
    case "thinking_delta":
      if (!currentThinking) currentThinking = addBubble("thinking");
      currentThinking.textContent += msg.delta;
      scrollDown();
      break;
    case "tool_start":
      toolChips.set(msg.toolName, addToolChip(msg.toolName));
      if (currentAssistant) currentAssistant.classList.remove("streaming");
      currentAssistant = null;
      break;
    case "tool_end": {
      const chip = toolChips.get(msg.toolName);
      if (chip) {
        setToolChip(chip, msg.isError ? "error" : "ok", msg.toolName);
        toolChips.delete(msg.toolName);
      }
      break;
    }
    case "session_new":
      $("messages").innerHTML = "";
      addSystem("— sesión nueva —");
      currentAssistant = null;
      currentThinking = null;
      break;
    case "model_changed":
      setCurrentModel(msg.model);
      addSystem(`— modelo cambiado a ${msg.model} —`);
      break;
    case "error":
      addSystem(`⚠️ ${msg.message}`);
      $("abort").classList.add("hidden");
      break;
  }
}

// ---------- comandos ----------
const COMMANDS = [
  { cmd: "/model", args: "<proveedor/id>", desc: "Cambia el modelo en vivo (no persiste)" },
  { cmd: "/models", args: "", desc: "Lista los modelos disponibles" },
  { cmd: "/new", args: "", desc: "Empieza una sesión nueva" },
  { cmd: "/status", args: "", desc: "Estado del agente" },
  { cmd: "/stop", args: "", desc: "Aborta la respuesta en curso" },
  { cmd: "/help", args: "", desc: "Muestra los comandos disponibles" },
];

// Skills (/skill:nombre) y prompt templates (/nombre) instalados — los expande pi.
let agentCommands = [];

async function loadAgentCommands() {
  const res = await fetch("/api/commands").catch(() => null);
  if (!res?.ok) return;
  const data = await res.json();
  agentCommands = [
    ...(data.skills || []).map((s) => ({ cmd: `/skill:${s.name}`, args: "", desc: s.description || "skill" })),
    ...(data.prompts || []).map((p) => ({ cmd: `/${p.name}`, args: p.argumentHint || "", desc: p.description || "prompt" })),
  ];
}

function allCommands() {
  return [...COMMANDS, ...agentCommands];
}

function hideCommandMenu() {
  $("command-menu").classList.add("hidden");
}

function renderCommandMenu(prefix) {
  const matches = allCommands().filter((c) => c.cmd.startsWith(prefix));
  const menu = $("command-menu");
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
    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // no robar el foco al textarea
      $("chat-input").value = c.cmd + (c.args ? " " : "");
      hideCommandMenu();
      $("chat-input").focus();
    });
    menu.appendChild(item);
  }
  menu.classList.remove("hidden");
}

function listModelsInChat() {
  const usable = modelCatalog.filter((m) => m.configured);
  if (!usable.length) {
    addSystem("Sin modelos con credenciales configuradas: revisa /data/global/models.json y las API keys / OAuth.");
    return;
  }
  for (const m of usable) {
    addSystem(`● ${m.provider}/${m.id} — ${m.name}`);
  }
}

// Devuelve true si el comando era de la UI; false → se reenvía al agente
// (pi expande /skill:nombre, prompt templates y comandos de extensiones).
async function runCommand(line) {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/help":
      for (const c of allCommands()) addSystem(`${c.cmd}${c.args ? ` ${c.args}` : ""} — ${c.desc}`);
      break;
    case "/models":
      if (!modelCatalog.length) await loadModels();
      listModelsInChat();
      break;
    case "/model":
      if (!arg) {
        addSystem("Uso: /model <proveedor/id>. Disponibles:");
        if (!modelCatalog.length) await loadModels();
        listModelsInChat();
        break;
      }
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "set_model", model: arg }));
      break;
    case "/new":
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "new_session" }));
      break;
    case "/stop":
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "abort" }));
      break;
    case "/status": {
      const res = await fetch("/api/status").catch(() => null);
      if (!res?.ok) {
        addSystem("⚠️ No se pudo obtener el estado");
        break;
      }
      const s = await res.json();
      addSystem(
        `Agente ${s.agent} · modelo ${s.model || "(default)"} · ${s.streaming ? "respondiendo" : "inactivo"} · telegram ${s.telegram ? "sí" : "no"} · memoria ${s.memory ? "sí" : "no"}`,
      );
      break;
    }
    default:
      return false; // no es de la UI: que lo procese pi (skills, templates, extensiones)
  }
  return true;
}

// ---------- chat ----------
function autoGrowTextarea(el) {
  el.style.height = "auto";
  const max = parseFloat(getComputedStyle(el).maxHeight) || 320;
  el.style.height = Math.min(el.scrollHeight, max) + "px";
}

function sendToAgent(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const content = addBubble("user");
  content.textContent = text;
  currentAssistant = null;
  currentThinking = null;
  ws.send(JSON.stringify({ type: "prompt", text }));
  $("chat-input").value = "";
  autoGrowTextarea($("chat-input"));
}

function sendPrompt() {
  const text = $("chat-input").value.trim();
  if (!text) return;
  hideCommandMenu();
  if (text.startsWith("/")) {
    $("chat-input").value = "";
    autoGrowTextarea($("chat-input"));
    void runCommand(text).then((handled) => {
      if (!handled) sendToAgent(text);
    });
    return;
  }
  sendToAgent(text);
}

$("chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendPrompt(); });
$("chat-input").addEventListener("input", (e) => {
  autoGrowTextarea(e.target);
  const value = e.target.value;
  if (/^\/[a-z0-9:_-]*$/i.test(value)) renderCommandMenu(value);
  else hideCommandMenu();
});
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideCommandMenu();
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});
$("chat-input").addEventListener("blur", () => setTimeout(hideCommandMenu, 150));
// ---------- adjuntos ----------
const TEXT_EXTENSIONS = /\.(txt|md|json|jsx?|tsx?|py|csv|log|ya?ml|html?|css|sh|xml|toml|ini|conf)$/i;

function insertIntoInput(text) {
  const input = $("chat-input");
  input.value = input.value ? `${input.value}\n${text}` : text;
  autoGrowTextarea(input);
  input.focus();
}

async function handleAttachment(file) {
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name)) {
    const reader = new FileReader();
    reader.onload = () => insertIntoInput("```" + file.name + "\n" + reader.result + "\n```\n");
    reader.readAsText(file);
    return;
  }
  if (file.type.startsWith("audio/") && sttOn) {
    addSystem("Transcribiendo audio…");
    const text = await transcribeBlob(file, file.name);
    if (text) insertIntoInput(text);
    return;
  }
  // Binario (PDF, imagen…): al workspace del agente; él lo procesa con sus tools.
  addSystem(`Subiendo ${file.name}…`);
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch("/api/upload", { method: "POST", body: form }).catch(() => null);
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok) {
    addSystem(`⚠️ No se pudo subir: ${body?.error || res?.status || "error de red"}`);
    return;
  }
  const kb = Math.max(1, Math.round(body.size / 1024));
  insertIntoInput(`[Archivo adjunto: ${body.path} — ${body.name}, ${body.type}, ${kb} KB. Léelo desde esa ruta del workspace.]`);
}

$("attach").addEventListener("click", () => $("attach-input").click());
$("attach-input").addEventListener("change", () => {
  const file = $("attach-input").files[0];
  $("attach-input").value = "";
  if (file) void handleAttachment(file);
});

// ---------- voz (STT) ----------
let sttOn = false;
let recorder = null;
let recordedChunks = [];

function setSttUi(enabled) {
  sttOn = Boolean(enabled);
  $("mic").classList.toggle("hidden", !sttOn);
}

async function transcribeBlob(blob, filename) {
  const form = new FormData();
  form.append("file", blob, filename);
  const res = await fetch("/api/transcribe", { method: "POST", body: form }).catch(() => null);
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok) {
    addSystem(`⚠️ Transcripción fallida: ${body?.error || res?.status || "error de red"}`);
    return "";
  }
  return body.text || "";
}

async function toggleRecording() {
  if (recorder) {
    recorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    addSystem("⚠️ Sin acceso al micrófono (revisa permisos del navegador; requiere HTTPS o localhost).");
    return;
  }
  recordedChunks = [];
  recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(recordedChunks, { type: recorder.mimeType || "audio/webm" });
    recorder = null;
    $("mic").classList.remove("recording");
    if (blob.size < 1000) return; // grabación vacía
    addSystem("Transcribiendo…");
    const text = await transcribeBlob(blob, "grabacion.webm");
    if (text) insertIntoInput(text);
  };
  recorder.start();
  $("mic").classList.add("recording");
}

$("mic").addEventListener("click", () => void toggleRecording());
$("abort").addEventListener("click", () => ws?.send(JSON.stringify({ type: "abort" })));
$("new-session").addEventListener("click", () => ws?.send(JSON.stringify({ type: "new_session" })));

// ---------- recursos ----------
async function loadResources() {
  const res = await fetch("/api/resources");
  if (!res.ok) return;
  const data = await res.json();
  renderPkgList($("list-agent"), data.agent, "agent");
  renderPkgList($("list-global"), data.global, "global");
}

function emptyRow(el) {
  el.innerHTML = "";
  const row = document.createElement("div");
  row.className = "list-item";
  const c = document.createElement("div");
  c.className = "list-item-sub";
  c.textContent = "— vacío —";
  row.appendChild(c);
  el.appendChild(row);
}

function renderPkgList(el, sources, scope) {
  el.innerHTML = "";
  if (!sources.length) return emptyRow(el);
  for (const source of sources) {
    const row = document.createElement("div");
    row.className = "list-item";
    const content = document.createElement("div");
    content.className = "list-item-content";
    const title = document.createElement("div");
    title.className = "list-item-title";
    title.style.fontFamily = "var(--font-mono)";
    title.style.fontSize = "var(--text-small)";
    title.textContent = source;
    content.appendChild(title);
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost btn-sm";
    btn.style.color = "var(--danger)";
    btn.textContent = "Quitar";
    btn.onclick = async () => {
      btn.disabled = true;
      await fetch("/api/resources", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, scope }),
      });
      setTimeout(loadResources, 800);
    };
    row.append(content, btn);
    el.appendChild(row);
  }
}

$("install-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const source = $("install-source").value.trim();
  if (!source) return;
  const scope = document.querySelector('input[name="scope"]:checked').value;
  $("install-status").textContent = "Instalando…";
  const res = await fetch("/api/resources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, scope }),
  });
  const body = await res.json().catch(() => ({}));
  $("install-status").textContent = res.ok
    ? `Instalado ✔${scope === "global" ? " (los agentes se reinician…)" : ""}`
    : `Error: ${body.error || res.status}`;
  $("install-source").value = "";
  setTimeout(loadResources, 1000);
});

// ---------- variables de entorno ----------
async function loadEnv() {
  const res = await fetch("/api/env");
  if (!res.ok) return;
  const data = await res.json();
  renderEnvList($("env-agent"), data.agent, "agent");
  renderEnvList($("env-global"), data.global, "global");
}

function renderEnvList(el, keys, scope) {
  el.innerHTML = "";
  if (!keys || !keys.length) return emptyRow(el);
  for (const key of keys) {
    const row = document.createElement("div");
    row.className = "list-item";
    const content = document.createElement("div");
    content.className = "list-item-content";
    const title = document.createElement("div");
    title.className = "list-item-title";
    title.style.fontFamily = "var(--font-mono)";
    title.style.fontSize = "var(--text-small)";
    title.textContent = key;
    const sub = document.createElement("div");
    sub.className = "list-item-sub";
    sub.textContent = "••••••";
    content.append(title, sub);
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost btn-sm";
    btn.style.color = "var(--danger)";
    btn.textContent = "Quitar";
    btn.onclick = async () => {
      btn.disabled = true;
      await fetch("/api/env", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, scope }),
      });
      setTimeout(loadEnv, 800);
    };
    row.append(content, btn);
    el.appendChild(row);
  }
}

$("env-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("env-key").value.trim();
  if (!key) return;
  const value = $("env-value").value;
  const scope = document.querySelector('input[name="env-scope"]:checked').value;
  $("env-status").textContent = "Guardando…";
  const res = await fetch("/api/env", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value, scope }),
  });
  const body = await res.json().catch(() => ({}));
  $("env-status").textContent = res.ok
    ? "Guardado ✔ (reiniciando agente…)"
    : `Error: ${body.error || res.status}`;
  $("env-key").value = "";
  $("env-value").value = "";
  setTimeout(loadEnv, 1000);
});

// ---------- init ----------
checkAuth().then((ok) => { if (ok) connect(); });
