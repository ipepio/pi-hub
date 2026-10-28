import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
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
import { readChannelRecords } from "./channels/store.js";

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

/** Compone el entorno final del Runner a partir del entorno ya filtrado.
 *
 * `channelKinds` (cutover, slice (c) part 3b): es la ÚNICA señal de canales que
 * recibe el Runner. No hay ningún secreto aquí: el bot lo posee el Manager y el
 * Runner solo necesita saber si hay un canal para su propio prompt de plataforma
 * y para el booleano de `/api/status`. Se deja fuera cuando está vacío para que
 * un arranque sin canales produzca un entorno idéntico al de antes.
 */
export function runnerEnvFor(
  storeEnv: NodeJS.ProcessEnv,
  env: PihubEnv,
  config: AgentConfig,
  callbackToken: string,
  channelKinds: readonly string[] = [],
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
    // Antes del cutover este era también el camino por el que el Runner filtraba
    // a qué usuarios respondía su propio bot. El allowlist dejó de tener efecto
    // en el Runner; se conserva porque es la config de plataforma que el Agent
    // puede inspeccionar, no porque la consuma nadie.
    PIHUB_TELEGRAM_ALLOWED_USERS: env.telegramAllowedUsers.join(","),
    ...(channelKinds.length > 0
      ? { PIHUB_CHANNEL_KINDS: channelKinds.join(",") }
      : {}),
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

/**
 * Dirección que el sondeo de puerto intenta atar. Es la MISMA que usa el Runner
 * (`packages/runner/src/server.ts`, `hostname: "0.0.0.0"`): en Darwin un socket que
 * escucha en `127.0.0.1:P` no impide atar `0.0.0.0:P` ni al revés, así que sondear
 * otra dirección produciría falsos «libre».
 */
const RUNNER_BIND_HOST = "0.0.0.0";
/** Cota del sondeo: un `listen` que no responde no puede colgar el arranque. */
const PORT_PROBE_TIMEOUT_MS = 5_000;

type CallbackTokenSource = () => string;

/**
 * Fence fail-closed del arranque (T4c). Comprueba que el puerto del Runner se puede
 * atar en exclusiva ANTES de abrir el log o spawnear, para que un spawn condenado a
 * `EADDRINUSE` no quede registrado como «en marcha» detrás de un ocupante vivo.
 *
 * No adopta, no interroga y no mata al ocupante, y NO prueba propiedad del puerto:
 * entre cerrar el sondeo y el bind del Runner sigue existiendo una ventana (TOCTOU)
 * que solo cerraría un protocolo de traspaso que aquí no existe.
 */
async function assertRunnerPortAvailable(
  agentName: string,
  port: number,
): Promise<void> {
  // Puerto efímero (`0`): el Runner lo resolverá al atar y no hay nada que sondear.
  if (!Number.isInteger(port) || port <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      probe.close();
      settle(
        new Error(
          `[supervisor] el sondeo del puerto ${port} de ${agentName} no respondió en ${PORT_PROBE_TIMEOUT_MS}ms; no se arranca`,
        ),
      );
    }, PORT_PROBE_TIMEOUT_MS);
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        const busy = new Error(
          `[supervisor] el puerto ${port} del Runner de ${agentName} ya está ocupado: no se arranca (el ocupante no se adopta ni se mata)`,
        );
        busy.name = "RunnerPortBusyError";
        settle(busy);
        return;
      }
      settle(
        new Error(
          `[supervisor] no se pudo comprobar que el puerto ${port} de ${agentName} esté libre (${error.code ?? error.message}); no se arranca`,
        ),
      );
    });
    // El sondeo se cierra ANTES de resolver: el Runner necesita el puerto ya.
    probe.listen({ host: RUNNER_BIND_HOST, port, exclusive: true }, () => {
      probe.close(() => settle());
    });
  });
}

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
    await assertRunnerPortAvailable(config.name, config.port);
    // Fence fail-closed: se llama aquí (y no en `start`) para que el auto-reinicio
    // quede fenced igual. Si el puerto está ocupado no se abre el log ni se spawnea.
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
        // Cutover (R3): el Runner no lee canales ni tokens — se lo dice este env.
        const channelKinds = [
          ...new Set((await readChannelRecords(this.env.dataDir, config.name)).map((record) => record.kind)),
        ].sort();
        const runnerEnv = runnerEnvFor(
          storeEnv,
          this.env,
          config,
          callbackToken,
          channelKinds,
        );
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
            readAgent(this.env.dataDir, config.name)
              .then((fresh) =>
                fresh?.enabled ? this.spawnRunner(fresh) : undefined,
              )
              .catch((error: unknown) => {
                // El fence también puede rechazar en un auto-reinicio. Sin este
                // consumidor, `void this.spawnRunner(...)` sería un
                // `unhandledRejection` que tumba el Manager entero; el Agent queda
                // `stopped` (nunca «en marcha») y el motivo se registra.
                console.error(
                  `[supervisor] no se pudo reiniciar ${config.name}:`,
                  error,
                );
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
    // La redacción se QUEDA aunque el campo sea legado: un `agent.json` escrito
    // antes del cutover, o editado a mano, no puede convertir `GET /agents` en un
    // chorreo de credenciales.
    const { telegramToken: _telegramToken, ...safe } = config;
    // Cutover (part 3b): `telegram` pasa a ser OBSERVADO desde el canal, no desde
    // el config del Runner. Un residuo legado en disco ya no pinta el chip del
    // panel; lo que lo pinta es que exista un registro de canal proyectado.
    const channelRecords = await readChannelRecords(this.env.dataDir, config.name);
    return {
      ...safe,
      state,
      pid,
      telegram: channelRecords.some((record) => record.kind === "telegram"),
    };
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.processes.keys()].map((name) => this.stop(name)),
    );
  }
}
