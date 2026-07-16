import { spawn, type ChildProcess } from "node:child_process";
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
export function memoryEnvFor(env: PihubEnv, config: AgentConfig): Record<string, string> {
  const access = env.memoryEnabled ? resolveSharedMemoryAccess(config, env) : "none";
  const memoryEnv: Record<string, string> = {
    PIHUB_AGENT_MEMORY_DIR: agentPaths(env.dataDir, config.name).memoryDir,
    PIHUB_SHARED_MEMORY_ACCESS: access,
  };
  if (access !== "none") {
    memoryEnv.PIHUB_GLOBAL_MEMORY_DIR = dataPaths(env.dataDir).globalMemoryDir;
  }
  return memoryEnv;
}

interface Managed {
  proc: ChildProcess;
  intentionalStop: boolean;
  restarts: number;
  lastStart: number;
  errored: boolean;
  /** true tras el evento 'exit' (proc.exitCode es null si murió por señal) */
  exited: boolean;
}

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;

export class Supervisor {
  private processes = new Map<string, Managed>();

  constructor(private env: PihubEnv) {}

  async startAll(): Promise<void> {
    for (const agent of await listAgents(this.env.dataDir)) {
      if (agent.enabled) {
        try {
          await this.start(agent.name);
        } catch (error) {
          console.error(`[supervisor] no se pudo arrancar ${agent.name}:`, error);
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
    const globalDir = dataPaths(this.env.dataDir).globalDir;
    const log = createWriteStream(path.join(paths.root, "runner.log"), { flags: "a" });

    // Env del contenedor + stores de env (global + agente), y encima las vars
    // internas de pihub, que son protegidas y siempre mandan.
    const storeEnv = await resolveRunnerEnv(this.env.dataDir, config.name, process.env);
    const runnerEnv: NodeJS.ProcessEnv = {
      ...storeEnv,
      PIHUB_DATA_DIR: this.env.dataDir,
      PIHUB_AGENT_NAME: config.name,
      PI_CODING_AGENT_DIR: globalDir,
      PI_CODING_AGENT_SESSION_DIR: paths.sessionsDir,
      ...memoryEnvFor(this.env, config),
    };
    // storeEnv arrastra process.env del manager: sin acceso compartido, la ruta
    // no debe llegar al runner ni aunque viniera del entorno del contenedor.
    if (runnerEnv.PIHUB_SHARED_MEMORY_ACCESS === "none") delete runnerEnv.PIHUB_GLOBAL_MEMORY_DIR;
    const proc = spawn(process.execPath, [runnerEntry], {
      env: runnerEnv,
      cwd: paths.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.pipe(log);
    proc.stderr?.pipe(log);

    const managed: Managed = {
      proc,
      intentionalStop: false,
      restarts: this.withinWindow(config.name) ? (this.processes.get(config.name)?.restarts ?? 0) + 1 : 0,
      lastStart: Date.now(),
      errored: false,
      exited: false,
    };
    this.processes.set(config.name, managed);
    console.log(`[supervisor] ${config.name} arrancado en :${config.port} (pid ${proc.pid})`);

    proc.on("exit", (code) => {
      managed.exited = true;
      log.end();
      if (managed.intentionalStop) return;
      if (managed.restarts >= MAX_RESTARTS) {
        managed.errored = true;
        console.error(`[supervisor] ${config.name} falló ${MAX_RESTARTS} veces seguidas; no se reinicia (código ${code})`);
        return;
      }
      const delay = Math.min(1000 * 2 ** managed.restarts, 15_000);
      console.warn(`[supervisor] ${config.name} terminó (código ${code}); reinicio en ${delay}ms`);
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

  state(name: string): { state: AgentRunState; pid?: number } {
    const managed = this.processes.get(name);
    if (!managed) return { state: "stopped" };
    if (!managed.exited) return { state: "running", pid: managed.proc.pid };
    return { state: managed.errored ? "errored" : "stopped" };
  }

  async statusOf(config: AgentConfig): Promise<AgentStatus> {
    const { state, pid } = this.state(config.name);
    // El token de Telegram nunca sale por la API: solo el boolean `telegram`.
    const { telegramToken: _telegramToken, ...safe } = config;
    return { ...safe, state, pid, telegram: Boolean(config.telegramToken) };
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((name) => this.stop(name)));
  }
}
