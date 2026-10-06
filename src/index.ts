import type { Plugin, ServerAPI } from "@signalk/server-api";

export const PLUGIN_ID = "signalk-huawei-b311-221";

export default function createPlugin(app: ServerAPI): Plugin {
  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: "Huawei B311-221 LTE",
    description:
      "Signal strength, connection status, data plan and SMS from a Huawei B311-221 LTE router",
    schema: () => ({
      type: "object",
      properties: {},
    }),
    start() {
      app.setPluginStatus("Not yet implemented");
    },
    stop() {},
  };
  return plugin;
}
