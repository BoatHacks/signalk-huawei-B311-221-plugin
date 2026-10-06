import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerAPI } from "@signalk/server-api";
import createPlugin, { PLUGIN_ID } from "../src/index.ts";

function fakeApp() {
  const statuses: string[] = [];
  const app = {
    setPluginStatus: (msg: string) => statuses.push(msg),
  } as unknown as ServerAPI;
  return { app, statuses };
}

test("plugin exposes id, name and a JSON schema object", () => {
  const { app } = fakeApp();
  const plugin = createPlugin(app);
  assert.equal(plugin.id, PLUGIN_ID);
  assert.ok(plugin.name.length > 0);
  const schema =
    typeof plugin.schema === "function" ? plugin.schema() : plugin.schema;
  assert.equal((schema as { type: string }).type, "object");
});

test("plugin starts and stops without throwing", async () => {
  const { app, statuses } = fakeApp();
  const plugin = createPlugin(app);
  plugin.start({}, () => {});
  await plugin.stop();
  assert.equal(statuses.length, 1);
});
