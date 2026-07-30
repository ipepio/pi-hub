// packages/manager/test/api-v1-auth.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldGlobalDirs } from "@pihub/shared";
import { createApi } from "../dist/api.js";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { classifyApiV1Auth, classifyServiceAuth } from "../src/api-v1/auth.ts";
import type { PihubEnv } from "@pihub/shared";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";

function fakeSupervisor(): Supervisor {
  return { state: () => ({ state: "stopped" }) } as unknown as Supervisor;
}

async function withRouter(run: (app: ReturnType<typeof createApiV1Router>) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-auth-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    await run(createApiV1Router({ dataDir, apiToken: "secreto" }, fakeSupervisor()));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("service auth de /api/v1", () => {
  it("sin header devuelve MISSING_AUTH", () => {
    assert.strictEqual(classifyServiceAuth(undefined, "secreto"), "MISSING_AUTH");
  });

  it("header vacío o sin Bearer devuelve MISSING_AUTH", () => {
    assert.strictEqual(classifyServiceAuth("", "secreto"), "MISSING_AUTH");
    assert.strictEqual(classifyServiceAuth("secreto", "secreto"), "MISSING_AUTH");
  });

  it("token que no coincide devuelve INVALID_AUTH, distinto de ausente", () => {
    // Distinguirlos es el criterio de H01.02: el dashboard reacciona
    // distinto a "no mandé credencial" que a "mi credencial ya no vale".
    assert.strictEqual(classifyServiceAuth("Bearer otro", "secreto"), "INVALID_AUTH");
  });

  it("token correcto devuelve ok", () => {
    assert.strictEqual(classifyServiceAuth("Bearer secreto", "secreto"), "ok");
  });

  it("no acepta cookie de sesión: el panel y el servicio son credenciales distintas", () => {
    // El guard viejo aceptaba cookie; /api/v1 es solo servicio-a-servicio.
    assert.strictEqual(classifyServiceAuth("pihub_session=secreto", "secreto"), "MISSING_AUTH");
  });
});

describe("dual auth de /api/v1", () => {
  it("Bearer válido clasifica como service sin exigir CSRF", () => {
    assert.deepStrictEqual(
      classifyApiV1Auth({
        authorizationHeader: "Bearer secreto",
        method: "POST",
        origin: "https://panel.example",
        requestOrigin: "https://panel.example",
      }, "secreto"),
      { kind: "service" },
    );
  });

  it("cookie válida permite una lectura sin CSRF", () => {
    assert.deepStrictEqual(
      classifyApiV1Auth({
        cookieHeader: "pihub_token=secreto",
        method: "GET",
        requestOrigin: "https://panel.example",
      }, "secreto"),
      { kind: "panel" },
    );
  });

  it("cookie inválida no autentica como panel", () => {
    assert.deepStrictEqual(
      classifyApiV1Auth({
        cookieHeader: "pihub_token=otro",
        method: "GET",
        requestOrigin: "https://panel.example",
      }, "secreto"),
      { kind: "invalid" },
    );
  });

  it("cookie válida en mutación sin CSRF se clasifica como fallo CSRF", () => {
    assert.deepStrictEqual(
      classifyApiV1Auth({
        cookieHeader: "pihub_token=secreto; pihub_csrf=csrf-real",
        method: "PATCH",
        requestOrigin: "https://panel.example",
      }, "secreto"),
      { kind: "csrf_invalid" },
    );
  });

  it("CSRF que no coincide se rechaza", () => {
    assert.deepStrictEqual(
      classifyApiV1Auth({
        cookieHeader: "pihub_token=secreto; pihub_csrf=csrf-real",
        method: "POST",
        csrfHeader: "csrf-falso",
        csrfCookie: "csrf-real",
        requestOrigin: "https://panel.example",
      }, "secreto"),
      { kind: "csrf_invalid" },
    );
  });

  it("Origin distinto se rechaza aunque el CSRF sea correcto", () => {
    assert.deepStrictEqual(
      classifyApiV1Auth({
        cookieHeader: "pihub_token=secreto; pihub_csrf=csrf-real",
        method: "DELETE",
        csrfHeader: "csrf-real",
        csrfCookie: "csrf-real",
        origin: "https://evil.example",
        requestOrigin: "https://panel.example",
      }, "secreto"),
      { kind: "csrf_invalid" },
    );
  });

  it("Bearer inválido no cae a la cookie del panel", () => {
    assert.deepStrictEqual(
      classifyApiV1Auth({
        authorizationHeader: "Bearer incorrecto",
        cookieHeader: "pihub_token=secreto",
        method: "GET",
        requestOrigin: "https://panel.example",
      }, "secreto"),
      { kind: "invalid" },
    );
  });
});

describe("emisión de sesión del panel", () => {
  it("rota y devuelve una cookie CSRF no HttpOnly junto a la sesión", async () => {
    const app = createApi(
      { apiToken: "secreto", panelEnabled: false } as PihubEnv,
      fakeSupervisor(),
      {} as OAuthService,
    );
    const response = await app.request("http://pihub.test/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secreto" }),
    });
    const body = (await response.json()) as { ok?: boolean; csrfToken?: string };
    const setCookie = response.headers.get("set-cookie") ?? "";

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.match(body.csrfToken ?? "", /^[0-9a-f]{64}$/);
    assert.match(setCookie, /pihub_token=secreto/);
    assert.match(setCookie, new RegExp(`pihub_csrf=${body.csrfToken}`));
    assert.doesNotMatch(setCookie, /pihub_csrf=[^;]+; HttpOnly/i);
  });
});

describe("middleware dual de /api/v1", () => {
  it("permite GET con cookie de panel sin CSRF", async () => {
    await withRouter(async (app) => {
      const response = await app.request("http://pihub.test/status", {
        headers: { cookie: "pihub_token=secreto" },
      });
      assert.strictEqual(response.status, 200);
    });
  });

  it("devuelve CSRF_REQUIRED para una mutación de panel sin token", async () => {
    await withRouter(async (app) => {
      const response = await app.request("http://pihub.test/auth/rotate", {
        method: "POST",
        headers: {
          cookie: "pihub_token=secreto; pihub_csrf=csrf-real",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await response.json()).code, "CSRF_REQUIRED");
    });
  });

  it("devuelve CSRF_INVALID para un token de mutación incorrecto", async () => {
    await withRouter(async (app) => {
      const response = await app.request("http://pihub.test/auth/rotate", {
        method: "POST",
        headers: {
          cookie: "pihub_token=secreto; pihub_csrf=csrf-real",
          "x-csrf-token": "csrf-falso",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await response.json()).code, "CSRF_INVALID");
    });
  });

  it("rechaza Origin incorrecto aunque cookie y CSRF sean válidos", async () => {
    await withRouter(async (app) => {
      const response = await app.request("http://pihub.test/auth/rotate", {
        method: "POST",
        headers: {
          cookie: "pihub_token=secreto; pihub_csrf=csrf-real",
          "x-csrf-token": "csrf-real",
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await response.json()).code, "CSRF_INVALID");
    });
  });

  it("Bearer inválido devuelve INVALID_AUTH aunque haya cookie válida", async () => {
    await withRouter(async (app) => {
      const response = await app.request("http://pihub.test/status", {
        headers: {
          authorization: "Bearer incorrecto",
          cookie: "pihub_token=secreto",
        },
      });
      assert.strictEqual(response.status, 401);
      assert.strictEqual((await response.json()).code, "INVALID_AUTH");
    });
  });
});
