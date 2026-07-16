import test from "node:test";
import assert from "node:assert/strict";
import { agentSocketUrl, agentPackagesUrl, agentEnvUrl } from "../public/agent-channel.js";

test("the Manager opens an Agent chat channel without navigating away", () => {
  assert.equal(
    agentSocketUrl({ protocol: "https:", hostname: "pihub.example" }, { port: 4103 }),
    "wss://pihub.example:4103/ws",
  );
});

test("the Manager addresses resources for the selected Agent", () => {
  assert.equal(agentPackagesUrl("linus"), "/api/packages?agent=linus");
  assert.equal(agentEnvUrl("linus"), "/api/env?agent=linus");
});
