// Day/night mode from Signal K environment.mode, polled over REST.
// Any error or unknown value falls back to day (never dim by accident).

export const ENVIRONMENT_MODE_URL = "/signalk/v1/api/vessels/self/environment/mode";
export const MODE_POLL_MS = 30_000;

export function parseMode(data) {
  const value = typeof data === "string" ? data : data?.value;
  return value === "night" ? "night" : "day";
}

export async function fetchMode(fetchFn = (...a) => globalThis.fetch(...a)) {
  try {
    const res = await fetchFn(ENVIRONMENT_MODE_URL, { credentials: "include" });
    if (!res.ok) return "day";
    return parseMode(await res.json());
  } catch {
    return "day";
  }
}

export function applyMode(mode, doc = globalThis.document) {
  const root = doc?.documentElement;
  if (root) root.dataset.mode = mode === "night" ? "night" : "day";
}

export function startModePolling(doc = globalThis.document) {
  const tick = async () => applyMode(await fetchMode(), doc);
  tick();
  return setInterval(tick, MODE_POLL_MS);
}
