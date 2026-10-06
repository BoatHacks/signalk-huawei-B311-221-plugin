import { PLUGIN_ID } from "./constants.ts";
import type { Pollers, PollKind, Timers } from "./pollers.ts";
import { createPollers } from "./pollers.ts";
import type { Publisher } from "./publisher.ts";
import { createPublisher } from "./publisher.ts";
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
  SmsMessage,
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

  const smsSummary = () => {
    const latest = smsStore.list().find((m) => m.direction === "in");
    return {
      unread: smsStore.unread(),
      ...(latest
        ? { lastMessage: latest.text, lastMessageTime: latest.timestamp }
        : {}),
    };
  };

  const publishSms = () => {
    smsSeen = true;
    publisher.publishSms(smsSummary());
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
    onSms(messages: SmsMessage[]) {
      const result = smsStore.ingest(messages);
      publishSms();
      if (config.notifyNewSms) {
        for (const m of result.newMessages) publisher.notifySms(m);
      }
    },
    onLink(state: LinkState, detail?: string) {
      link = state;
      publisher.publishRouterLink(state);
      publisher.notifyLink(state);
      if (state === "auth-failed") {
        const lockout = detail?.toLowerCase().includes("lockout");
        app.setPluginError(
          lockout
            ? "The router has locked out logins after too many attempts. Wait a while, then save the plugin settings again."
            : "The router rejected the login. Check the username and password; the plugin restarts when you save the settings.",
        );
      } else if (state === "unreachable") {
        app.setPluginStatus("Router unreachable, retrying");
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
            const ok = smsStore.markRead(id);
            publishSms();
            return ok;
          },
          remove: (id) => {
            const ok = smsStore.remove(id);
            publishSms();
            return ok;
          },
        },
        actions: {
          async send(to, text) {
            const result = await router.sendSms(to, text);
            if (result.status === "failed")
              throw new Error("The router reported the message as not sent");
            void pollers?.pollNow("sms").catch(() => {});
          },
          markRead: (index) => router.markRead(index),
          remove: (index) => router.deleteSms(index),
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
