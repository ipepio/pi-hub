import type { PihubEnv } from "@pihub/shared";
import {
  createRuntimeProviders,
  type RuntimeOAuthFlowState,
  type RuntimeProviders,
} from "@pihub/providers";

export type FlowState = RuntimeOAuthFlowState;

/**
 * Adapter de compatibilidad para las rutas legacy y v1. La custodia efectiva
 * y los flujos viven en RuntimeProviders; este módulo no abre auth.json.
 */
export class OAuthService {
  constructor(
    private readonly providersModule: RuntimeProviders,
  ) {}

  static fromEnv(env: PihubEnv): OAuthService {
    return new OAuthService(
      createRuntimeProviders({ dataDir: env.dataDir, oauthProviders: env.oauthProviders }),
    );
  }

  async providers(): Promise<Array<{ id: string; name: string; loggedIn: boolean }>> {
    return (await this.providersModule.snapshot()).oauthProviders;
  }

  async startLogin(providerId: string): Promise<FlowState> {
    const change = await this.providersModule.apply({ type: "start-oauth-login", providerId });
    if (!("flow" in change)) throw new Error("OAuth flow was not created");
    return change.flow;
  }

  getFlow(id: string): FlowState | undefined {
    return this.providersModule.oauthFlow(id);
  }

  async submitInput(id: string, value: string): Promise<FlowState> {
    const change = await this.providersModule.apply({
      type: "submit-oauth-input",
      flowId: id,
      value,
    });
    if (!("flow" in change)) throw new Error("OAuth flow was not updated");
    return change.flow;
  }

  async logout(providerId: string): Promise<void> {
    await this.providersModule.apply({ type: "logout-oauth", providerId });
  }
}
