import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldGlobalDirs } from "@pihub/shared";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createRuntimeProviders } from "../src/index.ts";

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-runtime-providers-"));
  await scaffoldGlobalDirs(dataDir);
  await fs.writeFile(
    path.join(dataDir, "global", "models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:9999/v1",
          api: "openai-completions",
          models: [{ id: "demo", name: "Demo", api: "openai-completions" }],
        },
      },
    }),
  );
  return dataDir;
}

test("RuntimeProviders registra Providers de Extension solo detrás del seam del Runner", async () => {
  const dataDir = await fixture();
  try {
    const providers = createRuntimeProviders({ dataDir, oauthProviders: [] });
    const loader = new DefaultResourceLoader({
      cwd: dataDir,
      agentDir: path.join(dataDir, "global"),
      extensionFactories: [
        (pi) => {
          pi.registerProvider("extension-provider", {
            baseUrl: "http://127.0.0.1:9996/v1",
            api: "openai-completions",
            apiKey: "extension-secret",
            models: [{ id: "extension-model", name: "Extension Model", api: "openai-completions" }],
          });
        },
      ],
    });
    await loader.reload();
    await providers.registerExtensionProviders(loader);

    const snapshot = await providers.snapshot();
    const extension = snapshot.providers.find((provider) => provider.id === "extension-provider");
    assert.equal(extension?.origin, "extension");
    assert.equal(extension?.status, "connected");
    assert.equal(JSON.stringify(snapshot).includes("extension-secret"), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("RuntimeProviders publica un snapshot seguro y resuelve Models desde el catálogo efectivo", async () => {
  const dataDir = await fixture();
  try {
    const providers = createRuntimeProviders({
      dataDir,
      oauthProviders: ["unknown-oauth-provider"],
    });

    const snapshot = await providers.snapshot();
    const resolved = await providers.resolveModel("local/demo");

    assert.equal(
      snapshot.models.some(
        (model) =>
          model.provider === "local" &&
          model.id === "demo" &&
          model.name === "Demo" &&
          model.configured === false,
      ),
      true,
    );
    assert.deepEqual(snapshot.oauthProviders, []);
    assert.deepEqual(snapshot.configurationIssues, [
      { code: "UNKNOWN_OAUTH_PROVIDER", providerId: "unknown-oauth-provider" },
    ]);
    assert.equal(resolved?.provider, "local");
    assert.equal(resolved?.id, "demo");
    assert.equal("authStorage" in snapshot, false);
    assert.equal(JSON.stringify(snapshot).includes(dataDir), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("RuntimeProviders aplica refresh sin cambiar la Interface pública del catálogo", async () => {
  const dataDir = await fixture();
  try {
    const providers = createRuntimeProviders({ dataDir, oauthProviders: [] });
    await fs.writeFile(
      path.join(dataDir, "global", "models.json"),
      JSON.stringify({
        providers: {
          local: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9999/v1",
            models: [{ id: "next", name: "Next", api: "openai-completions" }],
          },
        },
      }),
    );

    const change = await providers.apply({ type: "refresh" });

    assert.equal(change.kind, "refreshed");
    assert.equal(
      change.snapshot.models.some((model) => model.provider === "local" && model.id === "next"),
      true,
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("RuntimeProviders guarda definición y credencial de un Provider custom por separado", async () => {
  const dataDir = await fixture();
  try {
    const providers = createRuntimeProviders({ dataDir, oauthProviders: [] });
    const change = await providers.apply({
      type: "upsert-custom-provider",
      providerId: "custom",
      definition: {
        baseUrl: "http://127.0.0.1:9998/v1",
        models: [{ id: "custom-model", name: "Custom Model" }],
      },
      apiKey: "custom-secret",
    } as never);

    assert.equal(change.kind, "custom_provider_applied");
    const snapshot = change.snapshot;
    const custom = snapshot.providers.find((provider) => provider.id === "custom");
    assert.equal(custom?.origin, "models_json");
    assert.equal(custom?.status, "connected");
    assert.equal(JSON.stringify(snapshot).includes("custom-secret"), false);
    const modelsJson = await fs.readFile(path.join(dataDir, "global", "models.json"), "utf8");
    const authJson = await fs.readFile(path.join(dataDir, "global", "auth.json"), "utf8");
    assert.equal(modelsJson.includes("custom-secret"), false);
    assert.equal(authJson.includes("custom-secret"), true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("RuntimeProviders reemplaza solo la proyección managed y preserva Providers standalone", async () => {
  const dataDir = await fixture();
  try {
    const providers = createRuntimeProviders({ dataDir, oauthProviders: [] });
    const applied = await providers.apply({
      type: "replace-managed-providers",
      providers: [{
        id: "managed",
        baseUrl: "http://127.0.0.1:9997/v1",
        models: [{ id: "managed-model", name: "Managed Model" }],
        apiKey: "managed-secret",
      }],
    });

    assert.equal(applied.kind, "managed_projection_applied");
    assert.equal(applied.snapshot.providers.find((provider) => provider.id === "managed")?.origin, "managed");
    assert.equal(applied.snapshot.providers.some((provider) => provider.id === "local"), true);
    assert.equal(JSON.stringify(applied.snapshot).includes("managed-secret"), false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "global", "managed-providers.json"), "utf8")), {
      providerIds: ["managed"],
    });

    const removed = await providers.apply({ type: "replace-managed-providers", providers: [] });
    assert.equal(removed.snapshot.providers.some((provider) => provider.id === "managed"), false);
    assert.equal(removed.snapshot.providers.some((provider) => provider.id === "local"), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "global", "auth.json"), "utf8")).managed, undefined);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("RuntimeProviders resuelve API key del Env Store igual en Manager y Runner", async () => {
  const dataDir = await fixture();
  try {
    await fs.writeFile(
      path.join(dataDir, "global", "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:9999/v1",
            api: "openai-completions",
            apiKey: "$LOCAL_KEY",
            models: [{ id: "demo", name: "Demo", api: "openai-completions" }],
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(dataDir, "global", "env.json"),
      JSON.stringify({ LOCAL_KEY: "env-secret" }),
    );
    const manager = await createRuntimeProviders({ dataDir, oauthProviders: [] }).snapshot();
    const runner = await createRuntimeProviders({ dataDir, agentName: "agent", oauthProviders: [] }).snapshot();

    assert.equal(manager.models.find((model) => model.provider === "local" && model.id === "demo")?.configured, true);
    assert.deepEqual(manager.providers.find((provider) => provider.id === "local")?.authMethods, ["api_key"]);
    assert.deepEqual(manager, runner);
    assert.equal(JSON.stringify(manager).includes("env-secret"), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("RuntimeProviders expone API key configurada sin devolver el secreto", async () => {
  const dataDir = await fixture();
  try {
    await fs.writeFile(
      path.join(dataDir, "global", "auth.json"),
      JSON.stringify({ local: { type: "api_key", key: "super-secret-api-key" } }),
    );
    const snapshot = await createRuntimeProviders({ dataDir, oauthProviders: [] }).snapshot();
    const local = snapshot.providers.find((provider) => provider.id === "local");

    assert.deepEqual(local && {
      authMethods: local.authMethods,
      status: local.status,
    }, {
      authMethods: ["api_key"],
      status: "connected",
    });
    assert.equal(JSON.stringify(snapshot).includes("super-secret-api-key"), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("RuntimeProviders proyecta un Provider local sin autenticación como conectado", async () => {
  const dataDir = await fixture();
  try {
    const snapshot = await createRuntimeProviders({ dataDir, oauthProviders: [] }).snapshot();
    const local = snapshot.providers.find((provider) => provider.id === "local");

    assert.deepEqual(local && {
      id: local.id,
      origin: local.origin,
      authMethods: local.authMethods,
      status: local.status,
    }, {
      id: "local",
      origin: "models_json",
      authMethods: [],
      status: "connected",
    });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
