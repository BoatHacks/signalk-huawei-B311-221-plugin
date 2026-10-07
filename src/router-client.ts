import { type Bytes, cesu8Encode, cesu8Fix } from "./cesu8.ts";
import {
  AuthFailed,
  authReasonForCode,
  BadResponse,
  InvalidRequest,
  SessionBusy,
  Unreachable,
} from "./errors.ts";
import { encodePassword } from "./login.ts";
import {
  type ConnectionDetails,
  formatRouterDate,
  parseConnection,
  parseOperator,
  parseSendStatus,
  parseSignal,
  parseSmsList,
  parseTraffic,
} from "./parsers.ts";
import type {
  OperatorInfo,
  SignalSample,
  SmsMessage,
  TrafficSample,
} from "./types.ts";
import { type ParsedResponse, parseResponseXml } from "./xml.ts";

// The only module that knows endpoint URLs (ARCHITECTURE §2.1). Protocol:
// docs/ARCHITECTURE.md §5.1, modelled on huawei-lte-api (Session.py, User.py,
// Sms.py). Response FIELD NAMES live in parsers.ts and are unverified.

const ALLOWED_GET = new Set([
  "webserver/token",
  "webserver/SesTokInfo",
  "user/state-login",
  "device/information",
  "device/signal",
  "net/current-plmn",
  "monitoring/status",
  "monitoring/traffic-statistics",
  "sms/send-status",
]);
const ALLOWED_POST = new Set([
  "user/login",
  "user/logout",
  "sms/sms-list",
  "sms/send-sms",
  "sms/set-read",
  "sms/delete-sms",
]);

const LOGIN_REQUIRED = 100003;
const TOKEN_ERRORS = [125002, 125003];
const SUPPORTED_PASSWORD_TYPES = [0, 3, 4];
const NOT_SUPPORTED = 100002;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;

export interface RouterClientOptions {
  /** e.g. http://192.168.8.1. Only this origin is ever contacted. */
  baseUrl: string;
  username: string;
  password: string;
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Epoch milliseconds. Injected for tests. */
  now?: () => number;
  /** Injected for tests, so no real sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  /** Delay between send-status polls. Default 1 s. */
  sendPollIntervalMs?: number;
  /** Stop waiting for a send result after this long. Default 30 s. */
  sendTimeoutMs?: number;
  /** Diagnostics. Never receives the password, tokens or cookies. */
  log?: (message: string) => void;
}

export interface ListSmsOptions {
  /** 1-based router-side page. Default 1. */
  page?: number;
  /** Messages per page, 1-50. Default 20. */
  limit?: number;
  unreadPreferred?: boolean;
  ascending?: boolean;
}

export type SmsTextMode = "gsm7" | "ucs2";

export interface SendSmsResult {
  /** `unknown`: the router accepted the message but gave no final answer in time. */
  status: "sent" | "failed" | "unknown";
  mode: SmsTextMode;
}

// GSM 03.38 basic character set (no extension table). DECISION, UNVERIFIED:
// text made only of these goes out as 7-bit (Reserved=1), everything else,
// including the extension characters such as the euro sign, as UCS2
// (Reserved=0).
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);

/** Chooses the router's text mode and the `Length` value (UTF-16 units, unverified). */
export function chooseSmsMode(text: string): {
  mode: SmsTextMode;
  reserved: 0 | 1;
  length: number;
} {
  const gsm = [...text].every((c) => GSM_BASIC.has(c));
  return gsm
    ? { mode: "gsm7", reserved: 1, length: text.length }
    : { mode: "ucs2", reserved: 0, length: text.length };
}

type Field = [name: string, value: string | number | string[]];

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Ordered fields matter on some models, so a list rather than an object. */
function xmlRequest(fields: Field[]): Bytes {
  const inner = fields
    .map(([name, value]) =>
      Array.isArray(value)
        ? `<${name}>${value.map((v) => `<Phone>${xmlEscape(v)}</Phone>`).join("")}</${name}>`
        : `<${name}>${xmlEscape(String(value))}</${name}>`,
    )
    .join("");
  return cesu8Encode(`<request>${inner}</request>`);
}

function hasBadChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

interface RawResponse {
  status: number;
  text: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RouterClient {
  private readonly base: string;
  private readonly origin: string;
  private readonly username: string;
  private readonly password: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly sendPollIntervalMs: number;
  private readonly sendTimeoutMs: number;
  private readonly log: ((message: string) => void) | undefined;

  private jar = new Map<string, string>();
  private tokens: string[] = [];
  private loggedIn = false;
  private authError: AuthFailed | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: RouterClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new InvalidRequest("Router URL is not a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new InvalidRequest("Router URL must be http or https");
    }
    // `origin` carries no credentials, so userinfo in the URL is dropped.
    this.origin = url.origin;
    this.base = url.origin + url.pathname.replace(/\/+$/, "");
    this.username = options.username;
    this.password = options.password;
    this.fetchFn = options.fetch ?? ((i, n) => fetch(i, n));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.sendPollIntervalMs = options.sendPollIntervalMs ?? 1000;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 30_000;
    this.log = options.log;
  }

  /** True once a login was rejected. No further login is attempted until `clearAuthFailure()`. */
  get authFailed(): boolean {
    return this.authError !== undefined;
  }

  /** Allows a new login attempt, e.g. after the user changed the credentials. */
  clearAuthFailure(): void {
    this.authError = undefined;
  }

  // ---- public API (each call goes through the single queue) ---------------

  login(): Promise<void> {
    return this.enqueue(async () => {
      this.guardAuth();
      if (!this.loggedIn) await this.doLogin();
    });
  }

  /** Best effort. Network errors are swallowed; local session state is always dropped. */
  logout(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.loggedIn) return;
      try {
        await this.exchange("POST", "user/logout", xmlRequest([["Logout", 1]]));
      } catch {
        // The router may be gone already. Nothing to do.
      } finally {
        this.resetSession();
      }
    });
  }

  getSignal(): Promise<SignalSample> {
    return this.enqueue(async () =>
      parseSignal(await this.call("GET", "device/signal")),
    );
  }

  getOperator(): Promise<OperatorInfo> {
    return this.enqueue(async () =>
      parseOperator(await this.call("GET", "net/current-plmn")),
    );
  }

  getConnection(): Promise<ConnectionDetails> {
    return this.enqueue(async () => {
      const status = await this.call("GET", "monitoring/status");
      // WAN address and uptime come from device/information. Losing that
      // answer must not lose the link state, so a failure only drops them.
      let info: unknown;
      try {
        info = await this.call("GET", "device/information");
      } catch (e) {
        if (!(e instanceof BadResponse)) throw e;
      }
      return parseConnection(status, info);
    });
  }

  getTraffic(): Promise<TrafficSample> {
    return this.enqueue(async () => {
      const data = await this.call("GET", "monitoring/traffic-statistics");
      const sample = parseTraffic(data, this.now());
      if (!sample)
        throw new BadResponse("Traffic answer has no total counters");
      return sample;
    });
  }

  /** Inbox messages, paged on the router. */
  listSms(opts: ListSmsOptions = {}): Promise<SmsMessage[]> {
    const page = Math.max(1, Math.floor(opts.page ?? 1) || 1);
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(
        1,
        Math.floor(opts.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
      ),
    );
    return this.enqueue(async () => {
      const data = await this.call(
        "POST",
        "sms/sms-list",
        xmlRequest([
          ["PageIndex", page],
          ["ReadCount", limit],
          ["BoxType", 1], // local inbox
          ["SortType", 0], // by date
          ["Ascending", opts.ascending ? 1 : 0],
          ["UnreadPreferred", opts.unreadPreferred ? 1 : 0],
        ]),
      );
      return parseSmsList(data, { nowMs: this.now(), direction: "in" });
    });
  }

  /**
   * Sends one SMS, then polls sms/send-status until the router is done or
   * `sendTimeoutMs` passes. The queue stays held while polling, so no other
   * request interleaves with the send on the single session.
   */
  async sendSms(to: string, text: string): Promise<SendSmsResult> {
    if (!/^\+?\d{3,20}$/.test(to)) throw invalid("Phone number is not valid");
    if (text === "") throw invalid("Message text is empty");
    if (hasBadChars(text))
      throw invalid("Message text has unsupported characters");
    const { mode, reserved, length } = chooseSmsMode(text);
    return this.enqueue(async () => {
      const sentAt = formatRouterDate(this.now());
      expectOk(
        await this.call(
          "POST",
          "sms/send-sms",
          xmlRequest([
            ["Index", -1],
            ["Phones", [to]],
            ["Sca", ""],
            ["Content", text],
            ["Length", length],
            ["Reserved", reserved],
            ["Date", sentAt],
          ]),
        ),
        "sms/send-sms",
      );
      const deadline = this.now() + this.sendTimeoutMs;
      for (;;) {
        const status = parseSendStatus(
          await this.call("GET", "sms/send-status"),
        );
        if (status.done) return { status: status.ok ? "sent" : "failed", mode };
        if (this.now() >= deadline) return { status: "unknown", mode };
        await this.sleep(this.sendPollIntervalMs);
      }
    });
  }

  markRead(index: number): Promise<void> {
    return this.smsAction("sms/set-read", index);
  }

  deleteSms(index: number): Promise<void> {
    return this.smsAction("sms/delete-sms", index);
  }

  // ---- internals ------------------------------------------------------------

  private async smsAction(endpoint: string, index: number): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw invalid("SMS index is not valid");
    }
    return this.enqueue(async () => {
      expectOk(
        await this.call("POST", endpoint, xmlRequest([["Index", index]])),
        endpoint,
      );
    });
  }

  /** Runs `fn` after everything queued before it, whether that succeeded or not. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private guardAuth(): void {
    if (this.authError) throw this.authError;
  }

  private resetSession(): void {
    this.loggedIn = false;
    this.jar.clear();
    this.tokens = [];
  }

  /** An authenticated call: logs in lazily, recovers once from expiry or a token error. */
  private async call(
    method: "GET" | "POST",
    endpoint: string,
    body?: Bytes,
  ): Promise<unknown> {
    this.guardAuth();
    if (!this.loggedIn) await this.doLogin();
    let res = await this.exchange(method, endpoint, body);
    if (res.errorCode === LOGIN_REQUIRED) {
      this.log?.("Session expired, logging in again");
      this.resetSession();
      await this.doLogin();
      res = await this.exchange(method, endpoint, body);
    } else if (
      res.errorCode !== undefined &&
      TOKEN_ERRORS.includes(res.errorCode)
    ) {
      this.log?.("Token rejected, reloading tokens");
      await this.loadTokens();
      res = await this.exchange(method, endpoint, body);
    }
    if (res.errorCode !== undefined) {
      throw new BadResponse(
        res.errorCode === NOT_SUPPORTED
          ? `Router does not support ${endpoint}`
          : `Router returned error ${res.errorCode} for ${endpoint}`,
        res.errorCode,
      );
    }
    return res.data;
  }

  /** Always submits the password: the router's login state is not trusted (as huawei-lte-api's UserSession). */
  private async doLogin(): Promise<void> {
    this.resetSession();
    if (!this.password) {
      this.authError = new AuthFailed("credentials-missing");
      throw this.authError;
    }
    await this.loadTokens();
    const state = await this.exchange("GET", "user/state-login");
    if (state.errorCode === NOT_SUPPORTED) {
      // No login on this router.
      this.loggedIn = true;
      return;
    }
    if (state.errorCode !== undefined) {
      throw new BadResponse(
        "Router refused the login state request",
        state.errorCode,
      );
    }
    const passwordType = Number(
      (state.data as Record<string, unknown> | undefined)?.password_type ?? 0,
    );
    if (!SUPPORTED_PASSWORD_TYPES.includes(passwordType)) {
      this.authError = new AuthFailed("unsupported-password-type");
      throw this.authError;
    }
    const encoded = encodePassword(
      passwordType,
      this.username,
      this.password,
      this.tokens[0] ?? "",
    );
    const res = await this.exchange(
      "POST",
      "user/login",
      xmlRequest([
        ["Username", this.username],
        ["Password", encoded],
        ["password_type", passwordType],
      ]),
      { clearTokens: true },
    );
    if (res.errorCode === 108003) throw new SessionBusy();
    if (res.errorCode !== undefined) {
      const reason = authReasonForCode(res.errorCode);
      if (reason) {
        this.authError = new AuthFailed(reason, res.errorCode);
        throw this.authError;
      }
      throw new BadResponse(
        `Router returned error ${res.errorCode} on login`,
        res.errorCode,
      );
    }
    expectOk(res.data, "user/login");
    this.loggedIn = true;
    if (!this.tokens.length) await this.loadTokens();
    this.log?.(`Logged in (password_type ${passwordType})`);
  }

  /** GET / for the csrf meta token(s), falling back to the token endpoints. */
  private async loadTokens(): Promise<void> {
    this.tokens = [];
    const home = await this.send("GET", "/");
    const found = [
      ...home.text.matchAll(/name="csrf_token"\s+content="(\S+?)"/g),
    ].map((m) => m[1] as string);
    if (found.length) {
      this.tokens = found;
      return;
    }
    for (const [endpoint, key] of [
      ["webserver/token", "token"],
      ["webserver/SesTokInfo", "TokInfo"],
    ] as const) {
      const res = await this.exchange("GET", endpoint);
      const data = res.data;
      const token =
        typeof data === "object" && data !== null
          ? (data as Record<string, unknown>)[key]
          : undefined;
      if (typeof token === "string" && token.trim()) {
        this.tokens = [token.trim()];
        return;
      }
    }
  }

  /** One allowlisted API request, parsed. Does not log in or retry. */
  private async exchange(
    method: "GET" | "POST",
    endpoint: string,
    body?: Bytes,
    opts: { clearTokens?: boolean } = {},
  ): Promise<ParsedResponse> {
    const allowed = method === "GET" ? ALLOWED_GET : ALLOWED_POST;
    if (!allowed.has(endpoint)) {
      throw new InvalidRequest(
        `Refusing to call ${method} ${endpoint}: not on the allowlist`,
      );
    }
    const res = await this.send(method, `/api/${endpoint}`, body, opts);
    try {
      return parseResponseXml(res.text);
    } catch (e) {
      if (res.status >= 400) {
        throw new BadResponse(
          `Router answered HTTP ${res.status} for ${endpoint}`,
        );
      }
      throw e;
    }
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body?: Bytes,
    opts: { clearTokens?: boolean } = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {};
    if (method === "POST") {
      headers["Content-Type"] = "application/xml";
      // The token queue as in huawei-lte-api: consume one if several, else reuse.
      if (this.tokens.length > 1)
        headers.__RequestVerificationToken = this.tokens.shift() as string;
      else if (this.tokens.length === 1)
        headers.__RequestVerificationToken = this.tokens[0] as string;
    } else if (this.tokens.length === 1) {
      headers.__RequestVerificationToken = this.tokens[0] as string;
    }
    if (this.jar.size) {
      headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers,
        body: method === "POST" ? (body ?? new Uint8Array()) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Unreachable(`Router request failed: ${describeError(e)}`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new BadResponse(
        `Router redirected ${path} (redirects are not followed)`,
      );
    }
    if (res.url && new URL(res.url).origin !== this.origin) {
      await res.body?.cancel().catch(() => undefined);
      throw new BadResponse("Router answer came from an unexpected host");
    }
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair = ""] = sc.split(";");
      const i = pair.indexOf("=");
      if (i > 0)
        this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (opts.clearTokens) this.tokens = [];
    // The tokens a response carries replace whatever was queued: a router that
    // sends a fresh one on every response would otherwise grow the queue
    // without bound, and a POST would use the oldest, expired one.
    const one = res.headers.get("__RequestVerificationTokenone");
    if (one) {
      const two = res.headers.get("__RequestVerificationTokentwo");
      this.tokens = two ? [one, two] : [one];
    } else {
      const single = res.headers.get("__RequestVerificationToken");
      if (single) this.tokens = [single];
    }
    let bytes: Bytes;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new Unreachable(`Router answer was cut off: ${describeError(e)}`);
    }
    return {
      status: res.status,
      text: new TextDecoder().decode(cesu8Fix(bytes)),
    };
  }
}

const invalid = (message: string): Error => new InvalidRequest(message);

function expectOk(data: unknown, endpoint: string): void {
  if (typeof data !== "string" || data.toUpperCase() !== "OK") {
    throw new BadResponse(`Router did not confirm ${endpoint}`);
  }
}

/** Error class and OS error code only: never a URL, header or body. */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return "unknown error";
  const cause = (e as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === "string" ? ` ${cause.code}` : "";
  return `${e.name}${code}`;
}
