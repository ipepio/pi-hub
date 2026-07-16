import path from "node:path";
import { randomUUID } from "node:crypto";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { dataPaths, type PihubEnv } from "@pihub/shared";

export interface FlowState {
  id: string;
  provider: string;
  phase: "starting" | "auth_url" | "device_code" | "input" | "select" | "done" | "error";
  url?: string;
  instructions?: string;
  userCode?: string;
  message?: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string }>;
  progress?: string;
  error?: string;
}

interface Flow {
  state: FlowState;
  pendingInput?: (value: string) => void;
  abort: AbortController;
  createdAt: number;
}

const FLOW_TTL_MS = 10 * 60_000;

/** Flujos de login OAuth por proveedor, expuestos como máquina de estados via REST. */
export class OAuthService {
  readonly authStorage: AuthStorage;
  private flows = new Map<string, Flow>();

  constructor(private env: PihubEnv) {
    this.authStorage = AuthStorage.create(path.join(dataPaths(env.dataDir).globalDir, "auth.json"));
  }

  isEnabled(providerId: string): boolean {
    return this.env.oauthProviders.includes(providerId);
  }

  providers(): Array<{ id: string; name: string; loggedIn: boolean }> {
    this.authStorage.reload();
    return this.authStorage
      .getOAuthProviders()
      .filter((p) => this.isEnabled(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        loggedIn: this.authStorage.getAuthStatus(p.id).configured && this.authStorage.has(p.id),
      }));
  }

  startLogin(providerId: string): FlowState {
    if (!this.isEnabled(providerId)) {
      throw new Error(
        `OAuth para "${providerId}" no habilitado. Añádelo a PIHUB_OAUTH_PROVIDERS en el .env`,
      );
    }
    this.gc();
    const abort = new AbortController();
    const flow: Flow = {
      state: { id: randomUUID(), provider: providerId, phase: "starting" },
      abort,
      createdAt: Date.now(),
    };
    this.flows.set(flow.state.id, flow);

    const waitInput = (patch: Partial<FlowState>): Promise<string> =>
      new Promise<string>((resolve) => {
        Object.assign(flow.state, patch);
        flow.pendingInput = (value) => {
          flow.pendingInput = undefined;
          resolve(value);
        };
      });

    void this.authStorage
      .login(providerId, {
        signal: abort.signal,
        onAuth: (info) => {
          flow.state.phase = "auth_url";
          flow.state.url = info.url;
          flow.state.instructions = info.instructions;
        },
        onDeviceCode: (info) => {
          flow.state.phase = "device_code";
          flow.state.url = info.verificationUri;
          flow.state.userCode = info.userCode;
        },
        onProgress: (message) => {
          flow.state.progress = message;
        },
        onPrompt: (prompt) =>
          waitInput({ phase: "input", message: prompt.message, placeholder: prompt.placeholder }),
        onManualCodeInput: () =>
          waitInput({ phase: "input", message: "Pega el código de autorización" }),
        onSelect: (prompt) =>
          waitInput({ phase: "select", message: prompt.message, options: prompt.options }),
      })
      .then(() => {
        flow.state.phase = "done";
      })
      .catch((error: unknown) => {
        flow.state.phase = "error";
        flow.state.error = error instanceof Error ? error.message : String(error);
      });

    return flow.state;
  }

  getFlow(id: string): FlowState | undefined {
    return this.flows.get(id)?.state;
  }

  submitInput(id: string, value: string): FlowState {
    const flow = this.flows.get(id);
    if (!flow) throw new Error("Flujo no encontrado o caducado");
    if (!flow.pendingInput) throw new Error("El flujo no espera ninguna entrada ahora mismo");
    flow.state.phase = "starting";
    flow.pendingInput(value);
    return flow.state;
  }

  logout(providerId: string): void {
    this.authStorage.logout(providerId);
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, flow] of this.flows) {
      if (now - flow.createdAt > FLOW_TTL_MS) {
        flow.abort.abort();
        this.flows.delete(id);
      }
    }
  }
}
