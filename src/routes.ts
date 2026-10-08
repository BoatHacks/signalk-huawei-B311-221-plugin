import type { SmsMessage, StatusSnapshot } from "./types.ts";

// REST routes under /plugins/<id>/ (SPEC §6.2).
//
// Access control: the Signal K server makes any plugin route admin-only
// unless it was registered through `router.access(level)`. Reads opt in to
// "readonly"; writes are registered plainly and so stay admin-only, enforced
// by the server. Each write handler also checks admin itself as defence in
// depth. With server security disabled there is no admin concept and the
// server lets everyone through; the check mirrors that (see createAdminCheck).

export interface Req {
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
}
export interface Res {
  status(code: number): Res;
  json(body: unknown): unknown;
}
type Handler = (req: Req, res: Res) => unknown;

export interface RouterLike {
  /** Absent on older Signal K servers, whose plugin routes are all admin-only. */
  access?(level: "readonly" | "readwrite"): {
    get(path: string, ...handlers: Handler[]): unknown;
  };
  get(path: string, ...handlers: Handler[]): unknown;
  post(path: string, ...handlers: Handler[]): unknown;
  delete(path: string, ...handlers: Handler[]): unknown;
}

export interface RoutesDeps {
  getStatus(): StatusSnapshot;
  sms: {
    list(): SmsMessage[];
    markRead(id: string): boolean;
    remove(id: string): boolean;
  };
  actions: {
    /** `unknown` means the router took the message but never confirmed it. */
    send(
      to: string,
      text: string,
      // biome-ignore lint/suspicious/noConfusingVoidType: implementations and fakes may return nothing
    ): Promise<{ status: "sent" | "unknown" } | void>;
    /** Take the whole message so the action can check it still exists unchanged. */
    markRead(message: SmsMessage): Promise<void>;
    remove(message: SmsMessage): Promise<void>;
  };
  /** False when there is no plan to correct or the value is unusable. */
  setPlanUsed(usedBytes: number): boolean;
  resetPlan(): void;
  isAdmin(req: Req): boolean;
  now?: () => number;
  log?: (message: string) => void;
}

const MAX_TEXT_CHARS = 500;
const MAX_BODY_BYTES = 8 * 1024;
/** Far above any real plan (10 TB); only catches typos and junk. */
const MAX_USED_BYTES = 1e13;
const SEND_LIMIT = 5;
const SEND_WINDOW_MS = 60_000;
const DEFAULT_LIST = 50;
const MAX_LIST = 200;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Mirrors the server: no security strategy or a dummy one means unrestricted. */
export function createAdminCheck(app: {
  securityStrategy?: {
    isDummy?: () => boolean;
    hasAdminAccess?: (req: never) => boolean;
  };
}): (req: Req) => boolean {
  return (req) => {
    const strategy = app.securityStrategy;
    if (!strategy || strategy.isDummy?.()) return true;
    return strategy.hasAdminAccess?.(req as never) === true;
  };
}

async function readBody(req: Req): Promise<unknown> {
  if (
    req.body !== undefined &&
    typeof req.body === "object" &&
    req.body !== null
  )
    return req.body;
  const stream = req as unknown as AsyncIterable<Buffer | string>;
  if (typeof stream[Symbol.asyncIterator] !== "function") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, "Request body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function parseSend(body: unknown): { to: string; text: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  if (typeof b.to !== "string")
    throw new HttpError(400, "'to' must be a phone number");
  const to = b.to.replace(/[ \-().]/g, "");
  if (!/^\+?\d{5,20}$/.test(to))
    throw new HttpError(400, "'to' is not a valid phone number");
  if (typeof b.text !== "string" || b.text.trim() === "") {
    throw new HttpError(400, "'text' must be a non-empty string");
  }
  if ([...b.text].length > MAX_TEXT_CHARS) {
    throw new HttpError(
      400,
      `'text' is longer than ${MAX_TEXT_CHARS} characters`,
    );
  }
  return { to, text: b.text };
}

export function registerRoutes(router: RouterLike, deps: RoutesDeps): void {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const sends: number[] = [];

  const fail = (res: Res, e: unknown, what: string) => {
    if (e instanceof HttpError)
      return res.status(e.status).json({ error: e.message });
    // The runtime found the message changed on the router since the list was shown.
    if (e instanceof Error && e.name === "Conflict")
      return res.status(409).json({ error: e.message });
    log(
      `${what} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    );
    return res
      .status(502)
      .json({ error: "The router did not accept the request" });
  };

  const admin =
    (
      what: string,
      fn: (req: Req, res: Res) => Promise<unknown> | unknown,
    ): Handler =>
    async (req, res) => {
      if (!deps.isAdmin(req))
        return res.status(403).json({ error: "Admin rights required" });
      try {
        return await fn(req, res);
      } catch (e) {
        return fail(res, e, what);
      }
    };

  const messageFor = (req: Req): SmsMessage => {
    const found = deps.sms.list().find((m) => m.id === req.params?.id);
    if (!found) throw new HttpError(404, "No such message");
    return found;
  };

  // Older servers have no router.access(): reads then fall back to the plain
  // router, which that server treats as admin-only. Safe, just stricter.
  const readonly =
    typeof router.access === "function" ? router.access("readonly") : router;
  readonly.get("/status", (_req, res) => res.json(deps.getStatus()));
  readonly.get("/sms", (req, res) => {
    const n = Number(req.query?.limit);
    const limit =
      Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_LIST) : DEFAULT_LIST;
    return res.json({ messages: deps.sms.list().slice(0, limit) });
  });

  router.post(
    "/sms",
    admin("send sms", async (req, res) => {
      const { to, text } = parseSend(await readBody(req));
      const t = now();
      while (sends.length > 0 && (sends[0] as number) <= t - SEND_WINDOW_MS)
        sends.shift();
      if (sends.length >= SEND_LIMIT) {
        throw new HttpError(429, "Too many messages; try again in a minute");
      }
      sends.push(t);
      const result = await deps.actions.send(to, text);
      return res.json({
        ok: true,
        status: (result ? result.status : undefined) ?? "sent",
      });
    }),
  );

  router.post(
    "/sms/:id/read",
    admin("mark read", async (req, res) => {
      const msg = messageFor(req);
      await deps.actions.markRead(msg);
      deps.sms.markRead(msg.id);
      return res.json({ ok: true });
    }),
  );

  router.delete(
    "/sms/:id",
    admin("delete sms", async (req, res) => {
      const msg = messageFor(req);
      await deps.actions.remove(msg);
      deps.sms.remove(msg.id);
      return res.json({ ok: true });
    }),
  );

  router.post(
    "/plan/used",
    admin("set plan usage", async (req, res) => {
      const b = await readBody(req);
      const bytes = (b as { usedBytes?: unknown } | undefined)?.usedBytes;
      if (
        typeof bytes !== "number" ||
        !Number.isFinite(bytes) ||
        bytes < 0 ||
        bytes > MAX_USED_BYTES
      )
        throw new HttpError(
          400,
          "'usedBytes' must be a number of bytes, zero or more",
        );
      if (!deps.setPlanUsed(bytes))
        throw new HttpError(409, "No data plan is configured");
      return res.json({ ok: true });
    }),
  );

  router.post(
    "/plan/reset",
    admin("reset plan", (_req, res) => {
      deps.resetPlan();
      return res.json({ ok: true });
    }),
  );
}

/**
 * Routes are registered once, when the server loads the plugin, but the
 * plugin may be stopped or restarting. This wraps a router so every handler
 * answers 503 while `isUp()` is false.
 */
export function withAvailability(
  router: RouterLike,
  isUp: () => boolean,
): RouterLike {
  const wrap =
    (h: Handler): Handler =>
    (req, res) =>
      isUp()
        ? h(req, res)
        : res.status(503).json({ error: "The plugin is not running" });
  return {
    access: (level) => {
      const scoped =
        typeof router.access === "function" ? router.access(level) : router;
      return { get: (path, ...hs) => scoped.get(path, ...hs.map(wrap)) };
    },
    get: (path, ...hs) => router.get(path, ...hs.map(wrap)),
    post: (path, ...hs) => router.post(path, ...hs.map(wrap)),
    delete: (path, ...hs) => router.delete(path, ...hs.map(wrap)),
  };
}
