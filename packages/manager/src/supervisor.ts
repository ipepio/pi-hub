import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  agentPaths,
  dataPaths,
  listAgents,
  readAgent,
  resolveRunnerEnv,
  resolveSharedMemoryAccess,
  type AgentConfig,
  type AgentRunState,
  type AgentStatus,
  type PihubEnv,
} from "@pihub/shared";
import path from "node:path";
import { runnerEntry } from "./paths.js";

/**
 * Env de memoria que se inyecta al runner. El dir de Shared Memory solo existe
 * para el proceso si el acceso no es "none": la extensión deniega por nivel y,
 * además, sin la ruta no hay nada que resolver (doble capa).
 */
export function memoryEnvFor(
  env: PihubEnv,
  config: AgentConfig,
): Record<string, string> {
  const access = env.memoryEnabled
    ? resolveSharedMemoryAccess(config, env)
    : "none";
  const memoryEnv: Record<string, string> = {
    PIHUB_AGENT_MEMORY_DIR: agentPaths(env.dataDir, config.name).memoryDir,
    PIHUB_SHARED_MEMORY_ACCESS: access,
  };
  if (access !== "none") {
    memoryEnv.PIHUB_GLOBAL_MEMORY_DIR = dataPaths(env.dataDir).globalMemoryDir;
  }
  return memoryEnv;
}

/** Compone el entorno final del Runner a partir del entorno ya filtrado. */
export function runnerEnvFor(
  storeEnv: NodeJS.ProcessEnv,
  env: PihubEnv,
  config: AgentConfig,
  callbackToken: string,
): NodeJS.ProcessEnv {
  const paths = agentPaths(env.dataDir, config.name);
  const globalDir = dataPaths(env.dataDir).globalDir;
  const runnerEnv: NodeJS.ProcessEnv = {
    ...storeEnv,
    PIHUB_DATA_DIR: env.dataDir,
    PIHUB_AGENT_NAME: config.name,
    PI_CODING_AGENT_DIR: globalDir,
    PI_CODING_AGENT_SESSION_DIR: paths.sessionsDir,
    ...memoryEnvFor(env, config),
    PIHUB_TELEGRAM_ALLOWED_USERS: env.telegramAllowedUsers.join(","),
    PIHUB_RUNNER_CALLBACK_TOKEN: callbackToken,
    PIHUB_MANAGER_PORT: String(env.managerPort),
    // The Runner needs the service credential in its own env to (a) authorize
    // its inbound auth (server.ts /api/* middleware, WS upgrade, session) and
    // (b) let the governed tools (schedule_trigger/revoke_trigger in
    // agent-tools.ts) send the Authorization header to the Manager. The boot
    // scrub (R1-001, scrubProtectedProcessEnv in runner/index.ts) deletes
    // API_TOKEN from process.env before the pi-agent runs, so the credential
    // never reaches child bash processes. Do NOT reuse the callback token:
    // that authorizes a different surface.
    ...(env.apiToken ? { API_TOKEN: env.apiToken } : {}),
  };
  if (runnerEnv.PIHUB_SHARED_MEMORY_ACCESS === "none")
    delete runnerEnv.PIHUB_GLOBAL_MEMORY_DIR;
  return runnerEnv;
}

interface Managed {
  proc: ChildProcess;
  /** Credencial efímera y exclusiva de este spawn para callbacks internos al Manager. */
  callbackToken: string;
  /** Puerto del Runner (`config.port`): el Loop lo necesita para abrir el WS del turno. */
  port: number;
  intentionalStop: boolean;
  restarts: number;
  lastStart: number;
  errored: boolean;
  /** true tras el evento 'exit' (proc.exitCode es null si murió por señal) */
  exited: boolean;
}

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const CALLBACK_TOKEN_RE = /^[0-9a-fA-F]{64}$/;

type CallbackTokenSource = () => string;

function randomCallbackToken(): string {
  return randomBytes(32).toString("hex");
}

export class Supervisor {
  private processes = new Map<string, Managed>();

  constructor(
    private env: PihubEnv,
    /** Seam determinista reservado a tests; producción siempre usa 32 bytes aleatorios. */
    private callbackTokenSource: CallbackTokenSource = randomCallbackToken,
  ) {}

  async startAll(): Promise<void> {
    for (const agent of await listAgents(this.env.dataDir)) {
      if (agent.enabled) {
        try {
          await this.start(agent.name);
        } catch (error) {
          console.error(
            `[supervisor] no se pudo arrancar ${agent.name}:`,
            error,
          );
        }
      }
    }
  }

  private isRunning(name: string): boolean {
    const managed = this.processes.get(name);
    return !!managed && !managed.exited;
  }

  async start(name: string): Promise<void> {
    if (this.isRunning(name)) return;
    const config = await readAgent(this.env.dataDir, name);
    if (!config) throw new Error(`Agente desconocido: ${name}`);
    await this.spawnRunner(config);
  }

  private async spawnRunner(config: AgentConfig): Promise<void> {
    const paths = agentPaths(this.env.dataDir, config.name);
    const log = createWriteStream(path.join(paths.root, "runner.log"), {
      flags: "a",
    });

    // Solo el entorno del sistema permitido y los stores explícitos llegan al
    // Runner; las vars internas de pihub se añaden en la composición final.
    const storeEnv = await resolveRunnerEnv(
      this.env.dataDir,
      config.name,
      process.env,
    );
    const callbackToken = this.callbackTokenSource();
    const runnerEnv = runnerEnvFor(storeEnv, this.env, config, callbackToken);
    const proc = spawn(process.execPath, [runnerEntry], {
      env: runnerEnv,
      cwd: paths.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.pipe(log);
    proc.stderr?.pipe(log);

    const managed: Managed = {
      proc,
      callbackToken,
      port: config.port,
      intentionalStop: false,
      restarts: this.withinWindow(config.name)
        ? (this.processes.get(config.name)?.restarts ?? 0) + 1
        : 0,
      lastStart: Date.now(),
      errored: false,
      exited: false,
    };
    this.processes.set(config.name, managed);
    console.log(
      `[supervisor] ${config.name} arrancado en :${config.port} (pid ${proc.pid})`,
    );

    proc.on("exit", (code) => {
      managed.exited = true;
      log.end();
      if (managed.intentionalStop) return;
      if (managed.restarts >= MAX_RESTARTS) {
        managed.errored = true;
        console.error(
          `[supervisor] ${config.name} falló ${MAX_RESTARTS} veces seguidas; no se reinicia (código ${code})`,
        );
        return;
      }
      const delay = Math.min(1000 * 2 ** managed.restarts, 15_000);
      console.warn(
        `[supervisor] ${config.name} terminó (código ${code}); reinicio en ${delay}ms`,
      );
      setTimeout(() => {
        void readAgent(this.env.dataDir, config.name).then((fresh) => {
          if (fresh?.enabled) void this.spawnRunner(fresh);
        });
      }, delay);
    });
  }

  private withinWindow(name: string): boolean {
    const managed = this.processes.get(name);
    return !!managed && Date.now() - managed.lastStart < RESTART_WINDOW_MS;
  }

  async stop(name: string): Promise<void> {
    const managed = this.processes.get(name);
    if (!managed || managed.exited) return;
    managed.intentionalStop = true;
    // Revoca la credencial al observar el stop, sin esperar al evento de salida.
    managed.exited = true;
    managed.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        managed.proc.kill("SIGKILL");
        resolve();
      }, 5000);
      managed.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async restart(name: string): Promise<void> {
    await this.stop(name);
    this.processes.delete(name);
    await this.start(name);
  }

  async restartAllRunning(): Promise<void> {
    // Snapshot de nombres antes de iterar: restart() borra y re-inserta la clave
    // en this.processes, y el iterador vivo de un Map revisita entradas reinsertadas
    // (bucle infinito). Ver plan del fix.
    const names = [...this.processes.entries()]
      .filter(([, managed]) => !managed.exited)
      .map(([name]) => name);
    for (const name of names) await this.restart(name);
  }

  /**
   * Recarga el estado de credenciales en todos los Runners sin reiniciarlos.
   * El Runner responde 202 mientras tiene un turno vivo; se reintenta de forma
   * acotada para no cortar una respuesta normal ni conservar una revocación
   * indefinidamente en un proceso activo.
   */
  async reloadProviderState(): Promise<void> {
    const agents = await listAgents(this.env.dataDir);
    await Promise.all(
      agents
        .filter((agent) => agent.enabled && this.isRunning(agent.name))
        .map((agent) => this.reloadProviderStateFor(agent)),
    );
  }

  private async reloadProviderStateFor(config: AgentConfig): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${config.port}/api/providers/reload`,
          {
            method: "POST",
            headers: this.env.apiToken
              ? { authorization: `Bearer ${this.env.apiToken}` }
              : {},
          },
        );
        if (response.status === 200) return;
        if (response.status !== 202) return;
      } catch {
        // Runner may still be starting; the next attempt is safe and idempotent.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.warn(
      `[supervisor] no se pudo recargar credenciales del Agent ${config.name}`,
    );
  }

  state(name: string): { state: AgentRunState; pid?: number } {
    const managed = this.processes.get(name);
    if (!managed) return { state: "stopped" };
    if (!managed.exited) return { state: "running", pid: managed.proc.pid };
    return { state: managed.errored ? "errored" : "stopped" };
  }

  /**
   * Puerto del Runner de un Agent en marcha (Fase 3.5, plan §6): el Loop lo
   * necesita para abrir el WS del turno con `TurnExecution.startTurn`. Es la
   * misma condición que `state()==='running'` — si el Agent está en marcha, el
   * puerto existe; `undefined` en cualquier otro caso.
   */
  runnerPortOf(name: string): number | undefined {
    const managed = this.processes.get(name);
    return managed && !managed.exited ? managed.port : undefined;
  }

  /** Resuelve una credencial efímera de callback únicamente contra Runners vivos. */
  verifyCallbackToken(candidate: unknown): string | undefined {
    if (typeof candidate !== "string" || !CALLBACK_TOKEN_RE.test(candidate))
      return undefined;
    const candidateBuffer = Buffer.from(candidate, "hex");
    for (const [agentName, managed] of this.processes) {
      if (managed.exited || !CALLBACK_TOKEN_RE.test(managed.callbackToken))
        continue;
      const expectedBuffer = Buffer.from(managed.callbackToken, "hex");
      if (
        expectedBuffer.length === candidateBuffer.length &&
        timingSafeEqual(expectedBuffer, candidateBuffer)
      ) {
        return agentName;
      }
    }
    return undefined;
  }

  async statusOf(config: AgentConfig): Promise<AgentStatus> {
    const { state, pid } = this.state(config.name);
    // El token de Telegram nunca sale por la API: solo el boolean `telegram`.
    const { telegramToken: _telegramToken, ...safe } = config;
    return { ...safe, state, pid, telegram: Boolean(config.telegramToken) };
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.processes.keys()].map((name) => this.stop(name)),
    );
  }
}
