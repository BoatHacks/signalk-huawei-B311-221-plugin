import { PLUGIN_ID } from "./constants.ts";
import type { Pollers, PollKind, Timers } from "./pollers.ts";
import { createPollers } from "./pollers.ts";
import type { Publisher } from "./publisher.ts";
import { createPublisher } from "./publisher.ts";
import type { RouterClientOptions } from "./router-client.ts";
import { RouterClient } from "./router-client.ts";
import type { Req, RoutesDeps } from "./routes.ts";
import { SmsStore } from "./sms-store.ts";
import { StateStore } from "./state-store.ts";
import type {
  ConnectionStatus,
  LinkState,
  OperatorInfo,
  PluginConfig,
  SignalSample,
  SmsCounts,
  SmsMessage,
  SmsReport,
  StatusSnapshot,
  UsageAccount,
} from "./types.ts";
import type { UsageTracker } from "./usage-tracker.ts";
import { createUsageTracker } from "./usage-tracker.ts";

/** The slice of the Signal K server API the runtime uses. */
export interface RuntimeApp {
  handleMessage(pluginId: string, delta: object): void;
  setPluginStatus(message: string): void;
  setPluginError(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface RuntimeOptions {
  app: RuntimeApp;
  config: PluginConfig;
  dataDir: string;
  timers?: Timers;
  now?: () => number;
  fetch?: typeof fetch;
  /** Extra router client settings (timeouts, sleeping); for tests. */
  clientOptions?: Partial<RouterClientOptions>;
}

export interface Runtime {
  start(): Promise<void>;
  /** Stops polling, logs out of the router and saves state. */
  stop(): Promise<void>;
  pollNow(kind: PollKind): Promise<void>;
  status(): StatusSnapshot;
  routeDeps(isAdmin: (req: Req) => boolean): RoutesDeps;
}

/**
 * Builds everything the plugin needs from one configuration and wires the
 * router, pollers, publisher, usage tracker and SMS store together
 * (docs/plans/plugin-wiring.md). The server restarts the plugin on every
 * configuration change, so a runtime is built, used and thrown away.
 */
export function createRuntime(opts: RuntimeOptions): Runtime {
  const { app, config, dataDir } = opts;
  const now = opts.now ?? Date.now;

  const stateStore = new StateStore({
    dir: dataDir,
    onError: (err: unknown) =>
      app.error(`state: ${err instanceof Error ? err.message : String(err)}`),
  });
  const smsStore = new SmsStore({ state: stateStore });
  const publisher: Publisher = createPublisher(
    { handleMessage: (id, d) => app.handleMessage(id, d) },
    PLUGIN_ID,
  );
  const router = new RouterClient({
    baseUrl: config.routerUrl,
    username: config.username,
    password: config.password,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...opts.clientOptions,
    log: (m: string) => app.debug(`router: ${m}`),
  });

  let tracker: UsageTracker | undefined;
  let pollers: Pollers | undefined;
  let stopped = false;

  let link: LinkState = "connecting";
  let updatedAt: string | undefined;
  let signal: SignalSample | undefined;
  let operator: OperatorInfo | undefined;
  let connection: ConnectionStatus | undefined;
  let serviceKey: string | undefined;
  let smsSeen = false;
  // Messages we raised a notification for, so it can be cleared again.
  const notified = new Set<string>();

  // The router's own unread total. Our cache holds only the newest page, so
  // counting it would understate an inbox with older unread messages.
  let routerUnread: number | undefined;

  const smsSummary = () => {
    const latest = smsStore.list().find((m) => m.direction === "in");
    return {
      unread: routerUnread ?? smsStore.unread(),
      ...(latest
        ? { lastMessage: latest.text, lastMessageTime: latest.timestamp }
        : {}),
    };
  };

  const isUnread = (id: string) =>
    smsStore.list().some((m) => m.id === id && m.direction === "in" && !m.read);
  // Keep the router's total in step until the next poll confirms it.
  const dropUnread = () => {
    if (routerUnread !== undefined)
      routerUnread = Math.max(0, routerUnread - 1);
  };

  const publishSms = () => {
    smsSeen = true;
    publisher.publishSms(smsSummary());
  };

  const clearNotification = (id: string) => {
    if (notified.delete(id)) publisher.clearSmsNotification(id);
  };

  /**
   * The router reuses message indexes after a deletion, and our list can be a
   * poll interval old. Before acting on an index, make sure the router still
   * has the very message the user clicked at that index.
   */
  const confirmUnchanged = async (msg: SmsMessage) => {
    const fresh = await router.listSms({ limit: 50 });
    if (!fresh.some((m) => m.id === msg.id && m.index === msg.index)) {
      throw Object.assign(
        new Error("That message changed on the router; refresh the list"),
        { name: "Conflict" },
      );
    }
  };

  const saveUsage = () => {
    if (tracker) stateStore.save("usage", tracker.account());
  };

  // Status Tiles marks a path stale when it stops updating, so the slow
  // changing paths are re-sent on every signal tick (docs/plans/plugin-wiring.md).
  const republishSlow = () => {
    publisher.publishRouterLink(link);
    const snapshot = tracker?.snapshot();
    if (snapshot) publisher.publishPlan(snapshot);
    if (smsSeen) publisher.publishSms(smsSummary());
  };

  const handlers = {
    onSignal(data: {
      signal: SignalSample;
      operator: OperatorInfo;
      connection: ConnectionStatus;
    }) {
      signal = data.signal;
      operator = data.operator;
      connection = data.connection;
      updatedAt = new Date(now()).toISOString();
      const networkType =
        (data.connection as { networkType?: string }).networkType ??
        data.signal.networkType;
      publisher.publishSignal(
        networkType ? { ...data.signal, networkType } : data.signal,
      );
      publisher.publishOperator({
        operator: data.operator,
        serviceAvailable: data.connection.serviceAvailable,
        ...(networkType ? { networkType } : {}),
      });
      publisher.publishConnection(data.connection);
      const key = `${data.connection.serviceAvailable}|${data.connection.roaming ?? false}`;
      if (key !== serviceKey) {
        serviceKey = key;
        publisher.notifyService(data.connection);
      }
      republishSlow();
    },
    onTraffic(sample: Parameters<UsageTracker["update"]>[0]) {
      publisher.publishTraffic(sample);
      if (!tracker) return;
      const update = tracker.update(sample);
      if (update.ignored)
        app.debug(`traffic sample ignored: ${update.ignored}`);
      if (update.snapshot) publisher.publishPlan(update.snapshot);
      if (update.levelChanged)
        publisher.notifyPlan(update.level, update.snapshot);
      saveUsage();
    },
    onSms(messages: SmsMessage[], counts?: SmsCounts, reports?: SmsReport[]) {
      routerUnread = counts?.unread;
      const result = smsStore.ingest(messages, reports);
      publishSms();
      // A notification ends when its message is read or gone from the router.
      for (const id of [...notified]) {
        const m = messages.find((x) => x.id === id);
        if (!m || m.read) clearNotification(id);
      }
      if (config.notifyNewSms) {
        for (const m of result.newMessages) {
          publisher.notifySms(m);
          notified.add(m.id);
        }
      }
    },
    onLink(state: LinkState, detail?: string) {
      link = state;
      publisher.publishRouterLink(state);
      // "connecting" says nothing yet; reporting it as a healthy link would be wrong.
      if (state !== "connecting") publisher.notifyLink(state);
      if (state === "auth-failed") {
        const lockout = detail?.toLowerCase().includes("lockout");
        app.setPluginError(
          lockout
            ? "The router has locked out logins after too many attempts. Wait a while, then save the plugin settings again."
            : "The router rejected the login. Check the username and password; the plugin restarts when you save the settings.",
        );
      } else if (state === "unreachable") {
        app.setPluginStatus(
          detail?.includes("another admin session")
            ? "The router has another admin session open (for example its own web page); retrying"
            : "Router unreachable, retrying",
        );
      } else if (state === "ok") {
        app.setPluginStatus("Connected to the router");
      } else {
        app.setPluginStatus("Connecting to the router");
      }
    },
  };

  return {
    async start() {
      const usage = await stateStore.load<UsageAccount>("usage");
      tracker = createUsageTracker({ plan: config.plan, account: usage, now });
      await smsStore.load();
      if (stopped) return;
      publisher.sendMeta();
      pollers = createPollers({
        router,
        handlers,
        intervals: {
          signalMs: config.signalPollSeconds * 1000,
          trafficMs: config.trafficPollSeconds * 1000,
          smsMs: config.smsPollSeconds * 1000,
        },
        ...(opts.timers ? { timers: opts.timers } : {}),
        log: (m) => app.debug(`pollers: ${m}`),
      });
      pollers.start();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      await pollers?.stop();
      await router.logout();
      await stateStore.flush();
    },

    async pollNow(kind) {
      await pollers?.pollNow(kind);
    },

    status() {
      const snapshot = tracker?.snapshot();
      return {
        link,
        ...(updatedAt ? { updatedAt } : {}),
        ...(signal ? { signal } : {}),
        ...(operator ? { operator } : {}),
        ...(connection ? { connection } : {}),
        ...(snapshot ? { plan: snapshot } : {}),
        sms: smsSummary(),
      };
    },

    routeDeps(isAdmin) {
      return {
        getStatus: () => this.status(),
        sms: {
          list: () => smsStore.list(),
          markRead: (id) => {
            const wasUnread = isUnread(id);
            const ok = smsStore.markRead(id);
            if (ok && wasUnread) dropUnread();
            clearNotification(id);
            publishSms();
            return ok;
          },
          remove: (id) => {
            const wasUnread = isUnread(id);
            const ok = smsStore.remove(id);
            if (ok && wasUnread) dropUnread();
            clearNotification(id);
            publishSms();
            return ok;
          },
        },
        actions: {
          async send(to, text) {
            const id = smsStore.startSend(to, text, Date.now());
            let result: Awaited<ReturnType<typeof router.sendSms>>;
            try {
              result = await router.sendSms(to, text);
            } catch (e) {
              smsStore.discardSend(id);
              throw e;
            }
            smsStore.finishSend(id, result.status);
            if (result.status === "failed")
              throw new Error("The router reported the message as not sent");
            void pollers?.pollNow("sms").catch(() => {});
            return { status: result.status === "unknown" ? "unknown" : "sent" };
          },
          async markRead(msg) {
            if (msg.direction === "out") return;
            await confirmUnchanged(msg);
            await router.markRead(msg.index);
          },
          async remove(msg) {
            // Sent messages exist only in the plugin's own history.
            if (msg.direction === "out") return;
            await confirmUnchanged(msg);
            await router.deleteSms(msg.index);
          },
        },
        setPlanUsed(usedBytes) {
          if (!tracker) return false;
          const update = tracker.setUsed(usedBytes);
          if (update.ignored) return false;
          saveUsage();
          if (update.snapshot) publisher.publishPlan(update.snapshot);
          publisher.notifyPlan(update.level, update.snapshot);
          return true;
        },
        resetPlan() {
          if (!tracker) return;
          const update = tracker.reset();
          saveUsage();
          if (update.snapshot) publisher.publishPlan(update.snapshot);
          publisher.notifyPlan("normal", update.snapshot);
        },
        isAdmin,
        log: (m) => app.debug(`routes: ${m}`),
      };
    },
  };
}
