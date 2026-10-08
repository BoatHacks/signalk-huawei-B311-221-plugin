import type { Plugin, ServerAPI } from "@signalk/server-api";
import { configSchema, normalizeConfig } from "./config.ts";
import { PLUGIN_ID } from "./constants.ts";
import type { RouterLike, RoutesDeps } from "./routes.ts";
import {
  createAdminCheck,
  registerRoutes,
  withAvailability,
} from "./routes.ts";
import type { Runtime, RuntimeOptions } from "./runtime.ts";
import { createRuntime } from "./runtime.ts";
import { createTilesProvider } from "./tiles-provider.ts";

export { PLUGIN_ID };

export interface PluginOptions {
  /** Replaceable in tests. */
  createRuntime?: (opts: RuntimeOptions) => Runtime;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function createPlugin(
  app: ServerAPI,
  options: PluginOptions = {},
): Plugin {
  const build = options.createRuntime ?? createRuntime;
  const tiles = createTilesProvider(app, { pluginId: PLUGIN_ID });
  const isAdmin = createAdminCheck(
    app as unknown as Parameters<typeof createAdminCheck>[0],
  );
  let runtime: Runtime | undefined;
  let deps: RoutesDeps | undefined;

  // Routes are registered once; they look up the current runtime on each call.
  const current = (): RoutesDeps => {
    if (!runtime) throw new Error("The plugin is not running");
    deps ??= runtime.routeDeps(isAdmin);
    return deps;
  };
  const dynamicDeps: RoutesDeps = {
    getStatus: () => current().getStatus(),
    sms: {
      list: () => current().sms.list(),
      markRead: (id) => current().sms.markRead(id),
      remove: (id) => current().sms.remove(id),
    },
    actions: {
      send: (to, text) => current().actions.send(to, text),
      markRead: (m) => current().actions.markRead(m),
      remove: (m) => current().actions.remove(m),
    },
    setPlanUsed: (bytes) => current().setPlanUsed(bytes),
    resetPlan: () => current().resetPlan(),
    isAdmin,
    log: (m) => app.debug(`routes: ${m}`),
  };

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: "Huawei B311-221 LTE",
    description:
      "Signal strength, connection status, data plan and SMS from a Huawei B311-221 LTE router",
    schema: () => configSchema(),

    start(rawConfig) {
      const { config, errors } = normalizeConfig(rawConfig);
      tiles.start();
      if (!config.password) {
        // A fresh install has no password yet: say what is needed, not an error.
        app.setPluginStatus(
          "Waiting for the router's admin password in the plugin settings",
        );
        return;
      }
      if (errors.length > 0)
        app.error(`Configuration problems: ${errors.join("; ")}`);
      const rt = build({ app, config, dataDir: app.getDataDirPath() });
      runtime = rt;
      deps = undefined;
      rt.start().catch((e: unknown) => {
        app.setPluginError(`Failed to start: ${message(e)}`);
      });
    },

    async stop() {
      tiles.stop();
      const rt = runtime;
      runtime = undefined;
      deps = undefined;
      await rt?.stop();
    },

    registerWithRouter(router) {
      registerRoutes(
        withAvailability(
          router as unknown as RouterLike,
          () => runtime !== undefined,
        ),
        dynamicDeps,
      );
    },
  };
  return plugin;
}
