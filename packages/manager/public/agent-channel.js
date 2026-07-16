export function agentSocketUrl(location, agent) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.hostname}:${agent.port}/ws`;
}

export function agentPackagesUrl(name) {
  return `/api/packages?agent=${encodeURIComponent(name)}`;
}

export function agentEnvUrl(name) {
  return `/api/env?agent=${encodeURIComponent(name)}`;
}
