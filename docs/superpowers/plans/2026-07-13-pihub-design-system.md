# pihub Design System Port (Runner + Manager) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Adaptation note:** This plan restyles static HTML/CSS/JS with no test framework in the repo. There is no TDD red/green cycle here — each step's "test" is a `grep` cross-check (every id/class the JS touches still exists) plus a manual browser check. There is no git repository in this working directory, so steps do not include commit actions.

**Goal:** Apply the pihub Open Design brand spec (dark+light tokens, buttons, inputs, chips, lists, tabs, chat bubbles, tool-chips, status dots) to the Runner (agent chat) and Manager (admin panel) static UIs, mobile-first for the Runner chat, without touching backend TypeScript or breaking any existing WebSocket/fetch/tab/login behavior.

**Architecture:** Both packages already serve plain static files (`packages/*/public/{index.html,style.css,app.js|panel.js}`) via Hono with no bundler. Each `style.css` gets its own self-contained copy of the design tokens (no shared static mount exists between the two Hono servers, and adding one would require touching backend routing, which is out of scope). `app.js` and `panel.js` keep every existing `id` and all business logic; only a handful of CSS class names change, and each rename is paired with the matching JS edit in the same task.

**Tech Stack:** Vanilla HTML/CSS/JS, Hono static file serving, TypeScript backend (untouched).

## Global Constraints

- No React, no frontend framework, no bundler/build step for the frontend. Files stay as plain `.html`/`.css`/`.js` served statically.
- Do not touch `packages/*/src` (TypeScript backend).
- Every `id` currently referenced by `app.js` / `panel.js` must still exist with the same name after the HTML changes.
- Every CSS class renamed in HTML must have its JS references (if any) updated in the same task.
- Dark theme is the default (`data-theme="dark"` on `<html>`), with a light theme available via a toggle button that persists to `localStorage`.
- Runner chat layout must be mobile-first: base (no media query) styles target small screens; `@media (min-width: 640px)` enhances for larger viewports.
- Source of truth for tokens/components: `brand-spec.md` and `index.html` (component catalog) in the Open Design project at `/Users/iasacpepio/Library/Application Support/Open Design/namespaces/release-stable/data/projects/6ef1e39f-fbb5-4d39-bbbc-6892a2a10275/`.
- Verification command: `npm run build` from the repo root (`/Users/iasacpepio/Workspace/EGOB/GoGuest/goguest_agent_pi`). This only runs `tsc` per workspace — it does not touch `public/`, so it must keep passing throughout.

---

### Task 1: Runner — tokens, base styles, login, header/tabs, theme toggle

**Files:**
- Modify: `packages/runner/public/index.html` (full rewrite)
- Modify: `packages/runner/public/style.css` (full rewrite)
- Modify: `packages/runner/public/app.js:141-149` (tab-active rename + new theme block near top)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: CSS custom properties (`--bg`, `--surface`, `--surface-elevated`, `--border`, `--fg`, `--muted`, `--accent`, `--accent-dim`, `--danger`, `--danger-dim`, `--ok`, spacing/radius/shadow/font tokens) and utility classes (`.hidden`, `.muted`, `.error`, `.tab`, `.tab-active`, `.dot`, `.dot.ok`, `.list`, `.list li`) that Task 2 builds on for the chat/resources views.

- [ ] **Step 1: Rewrite `packages/runner/public/index.html`**

```html
<!doctype html>
<html lang="es" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>pihub · agente</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div id="login" class="hidden">
    <form id="login-form">
      <h1>pihub</h1>
      <p>Introduce el token de acceso</p>
      <input id="token-input" type="password" placeholder="API_TOKEN" autofocus />
      <button type="submit">Entrar</button>
      <p id="login-error" class="error"></p>
    </form>
  </div>

  <div id="app" class="hidden">
    <header>
      <div>
        <strong id="agent-name">agente</strong>
        <span id="model-name" class="muted"></span>
      </div>
      <nav>
        <button id="tab-chat" class="tab tab-active">Chat</button>
        <button id="tab-resources" class="tab">Recursos</button>
        <button id="new-session" title="Nueva sesión">＋ sesión</button>
        <span id="conn" class="dot" title="conexión"></span>
        <button id="theme-toggle" type="button" title="Cambiar tema" aria-label="Cambiar tema">🌙</button>
      </nav>
    </header>

    <main id="view-chat">
      <div id="messages"></div>
      <form id="chat-form">
        <textarea id="chat-input" rows="2" placeholder="Escribe un mensaje… (Enter para enviar, Shift+Enter salto de línea)"></textarea>
        <button id="send" type="submit">Enviar</button>
        <button id="abort" type="button" class="hidden danger">■ Parar</button>
      </form>
    </main>

    <main id="view-resources" class="hidden">
      <section>
        <h2>Instalar paquete</h2>
        <p class="muted">Extensiones, skills, prompts y templates: <code>npm:@scope/pkg</code>, <code>git:github.com/user/repo</code> o ruta local.</p>
        <form id="install-form">
          <input id="install-source" placeholder="npm:@foo/bar · git:github.com/user/repo@v1" />
          <label><input type="radio" name="scope" value="agent" checked /> Este agente</label>
          <label><input type="radio" name="scope" value="global" /> Global (todos)</label>
          <button type="submit">Instalar</button>
        </form>
        <p id="install-status" class="muted"></p>
      </section>
      <section>
        <h2>Instalados en este agente</h2>
        <ul id="list-agent" class="list"></ul>
        <h2>Instalados globalmente</h2>
        <ul id="list-global" class="list"></ul>
      </section>
      <section>
        <h2>Variables de entorno</h2>
        <p class="muted">Secretos y config (p.ej. tokens de API). Los valores no se muestran, solo los nombres. Reiniciará el agente al guardar.</p>
        <form id="env-form">
          <input id="env-key" placeholder="CLAVE" />
          <input id="env-value" type="password" placeholder="valor" />
          <label><input type="radio" name="env-scope" value="agent" checked /> Este agente</label>
          <label><input type="radio" name="env-scope" value="global" /> Global (todos)</label>
          <button type="submit">Guardar</button>
        </form>
        <p id="env-status" class="muted"></p>
        <h2>Definidas en este agente</h2>
        <ul id="env-agent" class="list"></ul>
        <h2>Definidas globalmente</h2>
        <ul id="env-global" class="list"></ul>
      </section>
    </main>
  </div>

  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Rewrite `packages/runner/public/style.css`**

```css
/* pihub — runner (agent chat) design system */

/* ===== Tokens ===== */
:root {
  --bg: #101418;
  --surface: #181e24;
  --surface-elevated: #1e252d;
  --border: #2a333c;
  --fg: #e6edf3;
  --muted: #8b98a5;
  --accent: #4ea1ff;
  --accent-dim: rgba(78, 161, 255, 0.15);
  --danger: #ff6b6b;
  --danger-dim: rgba(255, 107, 107, 0.15);
  --ok: #3ecf8e;

  --font-body: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
  --font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', ui-monospace, Menlo, monospace;

  --text-h3: 20px;
  --text-body: 16px;
  --text-small: 14px;
  --text-caption: 12px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;

  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  --transition-fast: 120ms ease;
}

[data-theme="light"] {
  --bg: #f8f9fb;
  --surface: #ffffff;
  --surface-elevated: #f0f2f5;
  --border: #d1d9e0;
  --fg: #1c2128;
  --muted: #656d76;
  --accent: #0969da;
  --accent-dim: rgba(9, 105, 218, 0.1);
  --danger: #cf222e;
  --danger-dim: rgba(207, 34, 46, 0.1);
  --ok: #1a7f37;
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.12);
}

/* ===== Reset & base ===== */
* { box-sizing: border-box; margin: 0; }

body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--text-body);
  line-height: 1.5;
  height: 100vh;
  display: flex;
  flex-direction: column;
  -webkit-font-smoothing: antialiased;
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }

.hidden { display: none !important; }
.muted { color: var(--muted); font-size: var(--text-caption); }
.error { color: var(--danger); min-height: 1.2em; font-size: var(--text-small); }
code { background: var(--surface-elevated); padding: 1px 5px; border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 0.9em; }

/* ===== Buttons ===== */
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-small);
  font-weight: 500;
  color: var(--fg);
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}
button:hover { border-color: var(--accent); color: var(--accent); }
button:active:not(:disabled) { transform: scale(0.98); }
button:disabled { opacity: 0.4; cursor: not-allowed; }

button[type="submit"] { background: var(--accent); color: #fff; border-color: var(--accent); }
button[type="submit"]:hover { filter: brightness(1.1); color: #fff; }

button.danger { color: var(--danger); }
button.danger:hover { border-color: var(--danger); color: var(--danger); }

/* ===== Inputs ===== */
input, textarea, select {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-body);
  font-size: var(--text-body);
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color var(--transition-fast);
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
input::placeholder, textarea::placeholder { color: var(--muted); }
textarea { resize: vertical; font-family: inherit; }
label { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-small); color: var(--muted); cursor: pointer; }
label input[type="radio"] { width: auto; }

/* ===== Login ===== */
#login { flex: 1; display: flex; align-items: center; justify-content: center; padding: var(--space-4); }
#login form {
  background: var(--surface);
  padding: var(--space-8) var(--space-6);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: 360px;
}
#login h1 { font-family: var(--font-display); font-size: var(--text-h3); font-weight: 600; text-align: center; }
#login p { text-align: center; color: var(--muted); font-size: var(--text-small); }

/* ===== App shell / header ===== */
#app { flex: 1; display: flex; flex-direction: column; min-height: 0; }

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  position: sticky;
  top: 0;
  z-index: 10;
}
header > div { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; overflow: hidden; }
header strong { font-family: var(--font-display); font-size: var(--text-small); font-weight: 600; white-space: nowrap; }
header .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

header nav { display: flex; gap: var(--space-1); align-items: center; flex-shrink: 0; }

.tab {
  background: transparent;
  border: none;
  color: var(--muted);
  padding: var(--space-2) var(--space-3);
  border-radius: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tab:hover { color: var(--fg); border-color: transparent; background: transparent; }
.tab-active, .tab-active:hover { color: var(--fg); border-bottom-color: var(--accent); }

.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); display: inline-block; transition: background var(--transition-fast); flex-shrink: 0; }
.dot.ok { background: var(--ok); }

#theme-toggle, #new-session {
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
  padding: var(--space-2);
}
#theme-toggle:hover, #new-session:hover { color: var(--fg); background: var(--surface-elevated); border-color: var(--border); }

/* ===== Chat (base rules live here; Task 2 appends resources-tab + responsive rules) ===== */
main { flex: 1; display: flex; flex-direction: column; min-height: 0; }
#view-chat, #view-resources { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }

#messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
}

.msg { padding: var(--space-3); border-radius: var(--radius-md); white-space: pre-wrap; word-break: break-word; max-width: 90%; font-size: var(--text-small); line-height: 1.6; }
.msg.user { background: var(--accent-dim); color: var(--fg); align-self: flex-end; }
.msg.assistant { background: var(--surface-elevated); border: 1px solid var(--border); align-self: flex-start; }
.msg.thinking { color: var(--muted); font-style: italic; border-style: dashed; }
.msg.system { color: var(--muted); font-size: var(--text-caption); align-self: center; background: none; padding: var(--space-2); }

.tool-chip {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  color: var(--muted);
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  border-radius: var(--radius-full);
  padding: var(--space-1) var(--space-3);
}
.tool-chip.error { color: var(--danger); border-color: var(--danger); }

#chat-form {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
  background: var(--surface);
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
}
#chat-input { flex: 1; resize: none; }
#send, #abort { flex-shrink: 0; }
```

- [ ] **Step 3: Add theme toggle logic to `packages/runner/public/app.js`**

Insert this block right after `const $ = (id) => document.getElementById(id);` (currently line 2):

```javascript
// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}
applyTheme(localStorage.getItem("pihub-theme") || "dark");
$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem("pihub-theme", next);
  applyTheme(next);
});
```

- [ ] **Step 4: Rename the tab "active" class in `packages/runner/public/app.js`**

Find (currently around lines 144-149):

```javascript
function switchTab(tab) {
  $("view-chat").classList.toggle("hidden", tab !== "chat");
  $("view-resources").classList.toggle("hidden", tab !== "resources");
  $("tab-chat").classList.toggle("active", tab === "chat");
  $("tab-resources").classList.toggle("active", tab === "resources");
}
```

Replace with:

```javascript
function switchTab(tab) {
  $("view-chat").classList.toggle("hidden", tab !== "chat");
  $("view-resources").classList.toggle("hidden", tab !== "resources");
  $("tab-chat").classList.toggle("tab-active", tab === "chat");
  $("tab-resources").classList.toggle("tab-active", tab === "resources");
}
```

- [ ] **Step 5: Verify every id/class `app.js` touches still exists in the new HTML**

Run:

```bash
cd /Users/iasacpepio/Workspace/EGOB/GoGuest/goguest_agent_pi
for id in login login-form token-input login-error app agent-name model-name tab-chat tab-resources new-session conn theme-toggle view-chat view-resources messages chat-form chat-input send abort install-form install-source install-status list-agent list-global env-form env-key env-value env-status env-agent env-global; do
  grep -q "id=\"$id\"" packages/runner/public/index.html || echo "MISSING: $id"
done
grep -c "tab-active" packages/runner/public/app.js
```

Expected: no `MISSING:` lines printed, and the last command prints `2` (both `classList.toggle("tab-active", ...)` calls).

---

### Task 2: Runner — resources tab styling + mobile-first responsive rules

**Files:**
- Modify: `packages/runner/public/style.css` (append to end of file)

**Interfaces:**
- Consumes: tokens and utility classes from Task 1 (`--space-*`, `--radius-*`, `.muted`, `button`, `input`).
- Produces: `.list` styling used by both `#list-agent`/`#list-global`/`#env-agent`/`#env-global`, and the mobile-first `@media` block.

- [ ] **Step 1: Append resources-tab and responsive rules to `packages/runner/public/style.css`**

```css

/* ===== Resources tab ===== */
section { margin: 0 auto var(--space-6); display: flex; flex-direction: column; gap: var(--space-3); padding: 0 var(--space-4); max-width: 800px; width: 100%; }
section:first-of-type { margin-top: var(--space-6); }
section h2 { font-family: var(--font-display); font-size: var(--text-h3); font-weight: 600; }

#install-form { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
#install-source { flex: 1; min-width: 200px; }

.list { list-style: none; display: flex; flex-direction: column; gap: var(--space-2); }
.list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  flex-wrap: wrap;
}
.list button { font-size: var(--text-caption); padding: var(--space-1) var(--space-3); }

/* ===== Responsive (mobile-first: unprefixed rules above already target small screens) ===== */
@media (min-width: 640px) {
  header { padding: var(--space-3) var(--space-6); }
  header strong { font-size: var(--text-body); }
  #messages { padding: var(--space-8) var(--space-6); }
  #chat-form { padding: var(--space-4) var(--space-6); }
  section { padding: 0 var(--space-6); }
}

@media (prefers-reduced-motion: reduce) {
  button:active { transform: none; }
}
```

- [ ] **Step 2: Verify no orphaned selectors remain from the old stylesheet**

Run:

```bash
cd /Users/iasacpepio/Workspace/EGOB/GoGuest/goguest_agent_pi
grep -n "pkg-list\|\.active\b" packages/runner/public/style.css packages/runner/public/index.html packages/runner/public/app.js
```

Expected: no output (the old `.pkg-list` class and the old generic `.active` tab class are fully replaced by `.list` and `.tab-active`).

---

### Task 3: Manager — tokens, base styles, login, header, theme toggle

**Files:**
- Modify: `packages/manager/public/index.html` (full rewrite)
- Modify: `packages/manager/public/style.css` (full rewrite)
- Modify: `packages/manager/public/panel.js:1-2` (new theme block near top)

**Interfaces:**
- Consumes: nothing from other tasks (Manager and Runner stylesheets are independent files; the token block below is intentionally duplicated from Task 1 since the two Hono servers do not share a static mount and adding one would touch the backend, which is out of scope).
- Produces: `.list`, `.state`, `.state.running`, `.state.errored`, `#theme-toggle` used by Task 4.

- [ ] **Step 1: Rewrite `packages/manager/public/index.html`**

```html
<!doctype html>
<html lang="es" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>pihub · manager</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div id="login" class="hidden">
    <form id="login-form">
      <h1>pihub manager</h1>
      <p>Introduce el token de acceso</p>
      <input id="token-input" type="password" placeholder="API_TOKEN" autofocus />
      <button type="submit">Entrar</button>
      <p id="login-error" class="error"></p>
    </form>
  </div>

  <div id="app" class="hidden">
    <header>
      <strong>pihub manager</strong>
      <nav>
        <span id="status-line" class="muted"></span>
        <button id="theme-toggle" type="button" title="Cambiar tema" aria-label="Cambiar tema">🌙</button>
      </nav>
    </header>

    <main>
      <section>
        <h2>Agentes</h2>
        <ul id="agent-list" class="list"></ul>
        <details id="create-agent">
          <summary>＋ Nuevo agente</summary>
          <form id="create-form">
            <input id="new-name" placeholder="nombre (minúsculas, guiones)" required />
            <input id="new-model" placeholder="modelo (proveedor/id, opcional)" />
            <input id="new-telegram" placeholder="token bot Telegram (opcional)" />
            <textarea id="new-system" rows="4" placeholder="System prompt / persona (opcional). Ej: Eres Linus Torvalds, dev senior con 10 años de experiencia…"></textarea>
            <input id="new-packages" placeholder="paquetes iniciales, separados por coma (opcional)" />
            <button type="submit">Crear</button>
            <span id="create-error" class="error"></span>
          </form>
        </details>
      </section>

      <section>
        <h2>Paquetes globales</h2>
        <form id="install-form">
          <input id="install-source" placeholder="npm:@foo/bar · git:github.com/user/repo@v1" />
          <button type="submit">Instalar global</button>
        </form>
        <p id="install-status" class="muted"></p>
        <ul id="global-packages" class="list"></ul>
      </section>

      <section>
        <h2>Variables de entorno globales</h2>
        <p class="muted">Secretos y config compartidos por todos los agentes (p.ej. <code>GITHUB_TOKEN</code>, <code>NAN_API_KEY</code>). Los valores no se muestran. Los agentes se reinician al guardar.</p>
        <form id="env-form">
          <input id="env-key" placeholder="CLAVE" />
          <input id="env-value" type="password" placeholder="valor" />
          <button type="submit">Guardar global</button>
        </form>
        <p id="env-status" class="muted"></p>
        <ul id="global-env" class="list"></ul>
      </section>

      <section id="oauth-section" class="hidden">
        <h2>Proveedores (OAuth)</h2>
        <ul id="oauth-list" class="list"></ul>
        <div id="oauth-flow" class="hidden">
          <p id="oauth-msg"></p>
          <a id="oauth-url" target="_blank" rel="noopener"></a>
          <p id="oauth-code" class="muted"></p>
          <form id="oauth-input-form" class="hidden">
            <input id="oauth-input" placeholder="pega aquí el código" />
            <button type="submit">Enviar</button>
          </form>
          <div id="oauth-select" class="hidden"></div>
        </div>
      </section>
    </main>
  </div>

  <script src="/panel.js"></script>
</body>
</html>
```

- [ ] **Step 2: Rewrite `packages/manager/public/style.css`**

```css
/* pihub — manager (admin panel) design system */

/* ===== Tokens ===== */
:root {
  --bg: #101418;
  --surface: #181e24;
  --surface-elevated: #1e252d;
  --border: #2a333c;
  --fg: #e6edf3;
  --muted: #8b98a5;
  --accent: #4ea1ff;
  --accent-dim: rgba(78, 161, 255, 0.15);
  --danger: #ff6b6b;
  --danger-dim: rgba(255, 107, 107, 0.15);
  --ok: #3ecf8e;

  --font-body: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
  --font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', ui-monospace, Menlo, monospace;

  --text-h3: 20px;
  --text-body: 16px;
  --text-small: 14px;
  --text-caption: 12px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;

  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  --transition-fast: 120ms ease;
}

[data-theme="light"] {
  --bg: #f8f9fb;
  --surface: #ffffff;
  --surface-elevated: #f0f2f5;
  --border: #d1d9e0;
  --fg: #1c2128;
  --muted: #656d76;
  --accent: #0969da;
  --accent-dim: rgba(9, 105, 218, 0.1);
  --danger: #cf222e;
  --danger-dim: rgba(207, 34, 46, 0.1);
  --ok: #1a7f37;
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.12);
}

/* ===== Reset & base ===== */
* { box-sizing: border-box; margin: 0; }

body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--text-body);
  line-height: 1.5;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }

.hidden { display: none !important; }
.muted { color: var(--muted); font-size: var(--text-caption); }
.error { color: var(--danger); min-height: 1.2em; font-size: var(--text-small); }
code { background: var(--surface-elevated); padding: 1px 5px; border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 0.9em; }

a { color: var(--accent); word-break: break-all; text-decoration: none; }
a:hover { text-decoration: underline; }

/* ===== Buttons ===== */
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-small);
  font-weight: 500;
  color: var(--fg);
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}
button:hover { border-color: var(--accent); color: var(--accent); }
button:active:not(:disabled) { transform: scale(0.98); }
button:disabled { opacity: 0.4; cursor: not-allowed; }

button[type="submit"] { background: var(--accent); color: #fff; border-color: var(--accent); }
button[type="submit"]:hover { filter: brightness(1.1); color: #fff; }

button.danger { color: var(--danger); }
button.danger:hover { border-color: var(--danger); color: var(--danger); }

/* ===== Inputs ===== */
input, textarea, select {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-body);
  font-size: var(--text-body);
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color var(--transition-fast);
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
input::placeholder, textarea::placeholder { color: var(--muted); }
textarea { resize: vertical; font-family: inherit; }

/* ===== Login ===== */
#login { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: var(--space-4); }
#login form {
  background: var(--surface);
  padding: var(--space-8) var(--space-6);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: 360px;
}
#login h1 { font-family: var(--font-display); font-size: var(--text-h3); font-weight: 600; text-align: center; }
#login p { text-align: center; color: var(--muted); font-size: var(--text-small); }

/* ===== Header ===== */
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  position: sticky;
  top: 0;
  z-index: 10;
}
header strong { font-family: var(--font-display); font-size: var(--text-body); font-weight: 600; }
header nav { display: flex; align-items: center; gap: var(--space-3); }

#theme-toggle {
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
  padding: var(--space-2);
}
#theme-toggle:hover { color: var(--fg); background: var(--surface-elevated); border-color: var(--border); }
```

(Task 4 appends the layout/list/state/forms rules to the end of this same file.)

- [ ] **Step 3: Add theme toggle logic to `packages/manager/public/panel.js`**

Insert this block right after `const $ = (id) => document.getElementById(id);` (currently line 2):

```javascript
// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}
applyTheme(localStorage.getItem("pihub-theme") || "dark");
$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem("pihub-theme", next);
  applyTheme(next);
});
```

- [ ] **Step 4: Verify every id `panel.js` touches still exists in the new HTML**

Run:

```bash
cd /Users/iasacpepio/Workspace/EGOB/GoGuest/goguest_agent_pi
for id in login login-form token-input login-error app status-line theme-toggle agent-list create-agent create-form new-name new-model new-telegram new-system new-packages create-error install-form install-source install-status global-packages env-form env-key env-value env-status global-env oauth-section oauth-list oauth-flow oauth-msg oauth-url oauth-code oauth-input-form oauth-input oauth-select; do
  grep -q "id=\"$id\"" packages/manager/public/index.html || echo "MISSING: $id"
done
```

Expected: no `MISSING:` lines printed.

---

### Task 4: Manager — agent list, forms, OAuth section styling

**Files:**
- Modify: `packages/manager/public/style.css` (append to end of file)

**Interfaces:**
- Consumes: tokens from Task 3.
- Produces: final `.list`, `.state`/`.state.running`/`.state.errored`, `.actions`, `details`/`summary` styles that `panel.js`'s `dot.className = \`state ${agent.state}\`` (backend states are exactly `"running"`, `"stopped"`, `"errored"` — see `packages/manager/src/supervisor.ts:153-155`) and dynamically-created `<li>`/`<button>` elements rely on via descendant selectors (no JS class changes needed here).

- [ ] **Step 1: Append layout/list/state/forms rules to `packages/manager/public/style.css`**

```css

/* ===== Main layout ===== */
main { max-width: 860px; margin: 0 auto; padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-8); }
section { display: flex; flex-direction: column; gap: var(--space-3); }
section h2 { font-family: var(--font-display); font-size: var(--text-h3); font-weight: 600; }

/* ===== Lists ===== */
.list { list-style: none; display: flex; flex-direction: column; gap: var(--space-2); }
.list li {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.list button { font-size: var(--text-caption); padding: var(--space-1) var(--space-3); }

.state { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--muted); margin-right: var(--space-2); flex-shrink: 0; }
.state.running { background: var(--ok); }
.state.errored { background: var(--danger); }

.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }

/* ===== Forms ===== */
#create-form, #oauth-flow { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-3); }
#install-form { display: flex; gap: var(--space-3); flex-wrap: wrap; }
#install-source { flex: 1; min-width: 200px; }

details {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
}
details summary { cursor: pointer; color: var(--accent); font-weight: 500; font-size: var(--text-small); }

/* ===== Responsive ===== */
@media (min-width: 640px) {
  header { padding: var(--space-3) var(--space-6); }
  main { padding: var(--space-6); }
}
```

- [ ] **Step 2: Verify no orphaned selectors remain from the old stylesheet**

Run:

```bash
cd /Users/iasacpepio/Workspace/EGOB/GoGuest/goguest_agent_pi
grep -n "card-list\|pkg-list" packages/manager/public/style.css packages/manager/public/index.html packages/manager/public/panel.js
```

Expected: no output.

---

### Task 5: Full verification (build + cross-package sanity check)

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: confirmation the port is complete and safe.

- [ ] **Step 1: Run the workspace build**

```bash
cd /Users/iasacpepio/Workspace/EGOB/GoGuest/goguest_agent_pi
npm run build
```

Expected: exits 0. Since `build` only runs `tsc -p tsconfig.json` per workspace and no `.ts` files were touched, this must pass exactly as it did before this plan started.

- [ ] **Step 2: Confirm no `.ts`/`.tsx` files were modified**

```bash
cd /Users/iasacpepio/Workspace/EGOB/GoGuest/goguest_agent_pi
find packages -name "*.ts" -newer docs/superpowers/plans/2026-07-13-pihub-design-system.md
```

Expected: no output (this plan file is written before any implementation step runs, so anything newer would flag an unintended backend edit).

- [ ] **Step 3: Confirm both HTML documents parse and reference exactly one theme toggle each**

```bash
cd /Users/iasacpepio/Workspace/EGOB/GoGuest/goguest_agent_pi
grep -c 'id="theme-toggle"' packages/runner/public/index.html packages/manager/public/index.html
grep -c 'data-theme="dark"' packages/runner/public/index.html packages/manager/public/index.html
```

Expected: `1` for each file in both commands.

- [ ] **Step 4: Manual visual check (report back to the user how to do this)**

Report to the user:
- Static style preview (no server needed): open `packages/runner/public/index.html` and `packages/manager/public/index.html` directly in a browser — the login card and (for a quick static look) `#app`/`#login` visibility toggling via `.hidden` can be inspected in devtools, but full functionality needs the server.
- Full functional check: start the runner (`cd packages/runner && npm run start`, requires the `dist/` build and an `API_TOKEN`/agent config already set up per existing docs) and open `http://localhost:<runner-port>/` to log in, send a chat message, switch to the Recursos tab, and toggle the theme button. Repeat for the manager on its own port to check agent list, package install, env vars, and OAuth section.
