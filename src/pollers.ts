import type {
  ConnectionStatus,
  LinkState,
  OperatorInfo,
  SignalSample,
  SmsCounts,
  SmsMessage,
  SmsPage,
  TrafficSample,
} from "./types.ts";

/** What the pollers need from the router client. */
export interface RouterPort {
  getSignal(): Promise<SignalSample>;
  getOperator(): Promise<OperatorInfo>;
  getConnection(): Promise<ConnectionStatus>;
  getTraffic(): Promise<TrafficSample>;
  getSmsCounts(): Promise<SmsCounts>;
  listSmsPage(opts?: { page?: number }): Promise<SmsPage>;
}

export interface PollerHandlers {
  onSignal(data: {
    signal: SignalSample;
    operator: OperatorInfo;
    connection: ConnectionStatus;
  }): void;
  onTraffic(sample: TrafficSample): void;
  /** `counts` are the router's own totals; missing when that call failed. */
  onSms(messages: SmsMessage[], counts?: SmsCounts): void;
  /** Called only when the link state changes. */
  onLink(state: LinkState, detail?: string): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type PollKind = "signal" | "traffic" | "sms";

export interface PollersOptions {
  router: RouterPort;
  handlers: PollerHandlers;
  intervals: { signalMs: number; trafficMs: number; smsMs: number };
  timers?: Timers;
  /** Longest wait between probes while the router is unreachable. */
  maxBackoffMs?: number;
  log?: (message: string) => void;
}

export interface Pollers {
  start(): void;
  /** Stops scheduling and waits for any request in flight. */
  stop(): Promise<void>;
  /** Runs one poll now, without changing the schedule. */
  pollNow(kind: PollKind): Promise<void>;
}

type Outcome =
  | { ok: true }
  | { ok: false; kind: "auth" | "unreachable" | "other"; message: string };

const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Most extra SMS pages one poll reads after a burst, and the most messages it asks for. */
const SMS_BURST_PAGES = 5;
const SMS_BURST_MAX = 100;

/**
 * Polls the router on three independent schedules, one request at a time.
 *
 * Link handling follows SPEC §3.1: a network failure moves to `unreachable`
 * and probes with the signal poll at a doubling, capped delay; rejected
 * credentials move to `auth-failed` and stop everything (retrying a rejected
 * login risks the router's lockout, so only a restart with new settings
 * resumes); any other failure is logged and retried on the normal schedule.
 * Errors are told apart by `error.name`, so this module does not depend on
 * the client's error classes.
 */
export function createPollers(opts: PollersOptions): Pollers {
  const { router, handlers, intervals } = opts;
  const timers: Timers = opts.timers ?? globalThis;
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const log = opts.log ?? (() => {});
  const intervalOf: Record<PollKind, number> = {
    signal: intervals.signalMs,
    traffic: intervals.trafficMs,
    sms: intervals.smsMs,
  };

  let running = false;
  let stopped = false;
  // The router's inbox total at the previous SMS poll.
  let lastInbox: number | undefined;
  let halted = false; // auth failure: nothing more happens until restart
  let link: LinkState | undefined;
  let backoffMs = 0;
  let chain: Promise<void> = Promise.resolve();
  const handles = new Map<PollKind, unknown>();

  const guard = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      log(
        `${what} handler failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const setLink = (state: LinkState, detail?: string) => {
    if (stopped || link === state) return;
    link = state;
    guard("link", () => handlers.onLink(state, detail));
  };

  const clearAll = () => {
    for (const h of handles.values()) timers.clearTimeout(h);
    handles.clear();
  };

  const schedule = (kind: PollKind, delay: number) => {
    if (!running || stopped || halted) return;
    const existing = handles.get(kind);
    if (existing !== undefined) timers.clearTimeout(existing);
    handles.set(
      kind,
      timers.setTimeout(() => {
        handles.delete(kind);
        void enqueue(kind, true);
      }, delay),
    );
  };

  const classify = (e: unknown): Outcome => {
    const name = e instanceof Error ? e.name : "";
    const message = e instanceof Error ? e.message : String(e);
    if (name === "AuthFailed") return { ok: false, kind: "auth", message };
    // A busy login session (another admin is logged in) clears by itself.
    if (name === "Unreachable" || name === "SessionBusy")
      return { ok: false, kind: "unreachable", message };
    return { ok: false, kind: "other", message };
  };

  const work = async (kind: PollKind): Promise<Outcome> => {
    try {
      if (kind === "signal") {
        const signal = await router.getSignal();
        const operator = await router.getOperator();
        const connection = await router.getConnection();
        if (!stopped)
          guard("signal", () =>
            handlers.onSignal({ signal, operator, connection }),
          );
      } else if (kind === "traffic") {
        const sample = await router.getTraffic();
        if (!stopped) guard("traffic", () => handlers.onTraffic(sample));
      } else {
        let counts: SmsCounts | undefined;
        try {
          counts = await router.getSmsCounts();
        } catch (e) {
          // The totals are a bonus; the messages matter more. Session
          // problems still surface through the list call below.
          if (!(e instanceof Error && e.name === "BadResponse")) throw e;
        }
        const first = await router.listSmsPage();
        const messages = first.messages;
        let unreadReports = first.unreadReports;
        // A page holds only the newest messages. If the inbox grew by more
        // than that since the last poll, read further back so none is missed.
        if (counts && lastInbox !== undefined) {
          const wanted = Math.min(counts.inbox - lastInbox, SMS_BURST_MAX);
          for (
            let page = 2;
            messages.length < wanted && page <= SMS_BURST_PAGES;
            page++
          ) {
            const more = await router.listSmsPage({ page });
            if (more.messages.length === 0) break;
            messages.push(...more.messages);
            unreadReports += more.unreadReports;
          }
        }
        lastInbox = counts?.inbox;
        // The router counts unread delivery reports as unread messages.
        const adjusted = counts && {
          inbox: counts.inbox,
          unread: Math.max(0, counts.unread - unreadReports),
        };
        if (!stopped) guard("sms", () => handlers.onSms(messages, adjusted));
      }
      return { ok: true };
    } catch (e) {
      return classify(e);
    }
  };

  const handle = (kind: PollKind, outcome: Outcome, scheduled: boolean) => {
    if (stopped || halted) return;
    if (outcome.ok) {
      const wasDown = link === "unreachable";
      setLink("ok");
      if (wasDown) {
        backoffMs = 0;
        void enqueue("traffic", true);
        void enqueue("sms", true);
        schedule("signal", intervalOf.signal);
        return;
      }
    } else if (outcome.kind === "auth") {
      halted = true;
      clearAll();
      setLink("auth-failed", outcome.message);
      return;
    } else if (outcome.kind === "unreachable") {
      clearAll();
      backoffMs = backoffMs
        ? Math.min(maxBackoff, backoffMs * 2)
        : Math.min(maxBackoff, intervalOf.signal * 2);
      setLink("unreachable", outcome.message);
      log(
        `router unreachable, next probe in ${Math.round(backoffMs / 1000)} s`,
      );
      schedule("signal", backoffMs);
      return;
    } else {
      log(`${kind} poll failed: ${outcome.message}`);
    }
    if (scheduled && link !== "unreachable") schedule(kind, intervalOf[kind]);
  };

  const enqueue = (kind: PollKind, scheduled: boolean): Promise<void> => {
    chain = chain.then(async () => {
      if (stopped || halted) return;
      // Only the signal probe runs while the router is unreachable; polls queued
      // before the failure was noticed must not mask it.
      if (link === "unreachable" && kind !== "signal") return;
      handle(kind, await work(kind), scheduled);
    });
    return chain;
  };

  return {
    start() {
      if (running || stopped) return;
      running = true;
      setLink("connecting");
      void enqueue("signal", true);
      void enqueue("traffic", true);
      void enqueue("sms", true);
    },
    async stop() {
      stopped = true;
      running = false;
      clearAll();
      await chain;
    },
    pollNow(kind) {
      return enqueue(kind, false);
    },
  };
}
