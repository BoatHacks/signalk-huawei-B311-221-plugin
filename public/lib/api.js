// Thin client for the plugin REST API. Relative URLs, session cookie included.

export const BASE = "/plugins/signalk-huawei-b311-221/";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status; // 0 = network failure
  }
}

async function request(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: "include",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network error");
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const msg =
      typeof data?.error === "string"
        ? data.error
        : typeof data?.message === "string"
          ? data.message
          : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data;
}

/** SMS list may be a bare array or { messages: [] }. */
export function normaliseSms(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.messages)
      ? data.messages
      : [];
  return list.filter((m) => m && typeof m === "object" && m.id !== undefined);
}

export const api = {
  status: () => request("status"),
  sms: async (limit = 50) => normaliseSms(await request(`sms?limit=${limit}`)),
  send: (to, text) => request("sms", { method: "POST", body: { to, text } }),
  markRead: (id) =>
    request(`sms/${encodeURIComponent(id)}/read`, { method: "POST" }),
  remove: (id) =>
    request(`sms/${encodeURIComponent(id)}`, { method: "DELETE" }),
  resetPlan: () => request("plan/reset", { method: "POST" }),
};
