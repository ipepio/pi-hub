import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isAuthorized, loadEnv, scrubProtectedProcessEnv } from "@pihub/shared";

// R1-001 (pihub step 2a): the service credential must not remain in the runner's
// process env after boot (the pi coding agent bash tool inherits it). The REAL
// exported helper (shared `scrubProtectedProcessEnv`) scrubs the exact protected
// env keys; the runner's index.ts calls it right after loadEnv() so authentication
// keeps using the values captured into the in-memory env object.

const SECRET = "runner-boot-secret";

test("the real scrub helper removes every protected secret from the given env", () => {
  // Exercise the REAL exported helper, not an inline re-implementation (R2-001).
  const env: NodeJS.ProcessEnv = {
    API_TOKEN: SECRET,
    PIHUB_RUNNER_CALLBACK_TOKEN: "cb-token",
    PIHUB_SPEECH_API_KEY: "tts-key",
  };

  scrubProtectedProcessEnv(env);

  assert.equal(env.API_TOKEN, undefined);
  assert.equal(env.PIHUB_RUNNER_CALLBACK_TOKEN, undefined);
  assert.equal(env.PIHUB_SPEECH_API_KEY, undefined);
});

test("the scrub keeps non-secret PIHUB_* config (the pi runtime may need them)", () => {
  const env: NodeJS.ProcessEnv = {
    API_TOKEN: SECRET,
    PIHUB_MANAGER_PORT: "4000",
    PI_CODING_AGENT_MODEL: "anthropic/claude-sonnet-5",
  };
  scrubProtectedProcessEnv(env);
  assert.equal(env.API_TOKEN, undefined, "el secreto se borra");
  assert.equal(env.PIHUB_MANAGER_PORT, "4000", "la config PIHUB_* se conserva");
  assert.equal(
    env.PI_CODING_AGENT_MODEL,
    "anthropic/claude-sonnet-5",
    "la config PI_CODING_AGENT_* se conserva",
  );
});

test("after boot scrub, a child process spawned with the inherited env lacks API_TOKEN", () => {
  process.env.API_TOKEN = SECRET;

  // Boot: loadEnv() captures the credential into the in-memory env object, then
  // the runner scrubs process.env (index.ts). Verified end-to-end via a real node
  // child that inherits the (post-scrub) process.env.
  const env = loadEnv();
  assert.equal(env.apiToken, SECRET);

  scrubProtectedProcessEnv(process.env);
  assert.equal(process.env.API_TOKEN, undefined);

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "process.stdout.write(process.env.API_TOKEN === undefined ? 'MISSING' : process.env.API_TOKEN)",
    ],
    {
      encoding: "utf8",
      env: process.env, // inherited env minus the scrubbed secret
    },
  );
  assert.equal(child.status, 0, `child exit ${child.status}: ${child.stderr}`);
  assert.equal(child.stdout.trim(), "MISSING", "el hijo NO hereda API_TOKEN");

  // Authentication keeps comparing against the captured value, not process.env.
  assert.equal(isAuthorized(env.apiToken, `Bearer ${SECRET}`, undefined), true);
  assert.equal(
    isAuthorized(env.apiToken, "Bearer wrong-token", undefined),
    false,
  );
  assert.equal(
    isAuthorized(env.apiToken, undefined, `pihub_token=${SECRET}`),
    true,
  );
});
