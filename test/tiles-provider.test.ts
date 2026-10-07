import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServerAPI } from "@signalk/server-api";
import {
  createTilesProvider,
  EXAMPLES_RESOURCE_TYPE,
  loadExamples,
} from "../src/tiles-provider.ts";

// Optional: a checkout of signalk-status-tiles to validate against. Set
// STATUS_TILES_DIR to its path; without it those tests are skipped.
const STATUS_TILES_DIR = process.env.STATUS_TILES_DIR ?? "";
const PLUGIN_ID = "signalk-huawei-b311-221";

/** Every path a tile may reference: SPEC §6.1. */
const ALLOWED_PATHS = new Set([
  "networking.lte.rssi",
  "networking.lte.rsrp",
  "networking.lte.rsrq",
  "networking.lte.sinr",
  "networking.lte.bars",
  "networking.lte.radioQuality",
  "networking.lte.connectionType",
  "networking.lte.registerNetworkDisplay",
  "networking.lte.connectionText",
  "networking.lte.curBand",
  "networking.lte.cellId",
  "networking.lte.pci",
  "networking.lte.roaming",
  "networking.wan.ip",
  "networking.modem.uptime",
  "networking.lte.usage.rx",
  "networking.lte.usage.tx",
  "networking.lte.plan.totalBytes",
  "networking.lte.plan.usedBytes",
  "networking.lte.plan.remainingBytes",
  "networking.lte.plan.usedRatio",
  "networking.lte.plan.periodEnd",
  "networking.lte.lastMessage",
  "networking.lte.lastMessageTime",
  "networking.lte.sms.unread",
  "networking.lte.routerLink",
]);

interface Check {
  type: string;
  path?: string;
  display?: boolean;
  staleState?: string;
  staleMs?: number;
  default?: string;
  map?: { value: string; state: string }[];
  high?: { warn?: number; crit?: number };
  zones?: { lower?: number; upper?: number; state: string }[];
}
interface Tile {
  id: string;
  label: string;
  checks: Check[];
  footer?: { path: string }[];
  displayParts?: { path: string }[];
}
interface ExampleSet {
  id: string;
  tiles: Tile[];
  contexts?: { id: string }[];
}
interface Examples {
  name: string;
  sets: ExampleSet[];
}

const examples = JSON.parse(
  readFileSync(
    new URL("../status-tiles-examples.json", import.meta.url),
    "utf8",
  ),
) as Examples;
const set = examples.sets[0] as ExampleSet;

function tile(id: string): Tile {
  const t = set.tiles.find((x) => x.id === id);
  assert.ok(t, `tile ${id} exists`);
  return t;
}

function usedPaths(t: Tile): string[] {
  return [
    ...t.checks.flatMap((c) => (c.path ? [c.path] : [])),
    ...(t.footer ?? []).map((f) => f.path),
    ...(t.displayParts ?? []).map((f) => f.path),
  ];
}

test("example file has the expected structure", () => {
  assert.equal(typeof examples.name, "string");
  assert.equal(examples.sets.length, 1);
  assert.equal(set.id, "huawei-b311");
  assert.match(set.id, /^[A-Za-z][A-Za-z0-9_-]*$/);
  const ids = set.tiles.map((t) => t.id);
  assert.deepEqual(ids, [
    "huaweiSignal",
    "huaweiConnection",
    "huaweiPlan",
    "huaweiRouterLink",
    "huaweiSms",
  ]);
  assert.equal(new Set(ids).size, ids.length);
  const ctxIds = new Set((set.contexts ?? []).map((c) => c.id));
  for (const t of set.tiles) {
    assert.match(t.id, /^[A-Za-z][A-Za-z0-9_-]*$/);
    assert.ok(t.label.length > 0);
    assert.ok(t.checks.length > 0);
    assert.ok(t.checks.filter((c) => c.display).length <= 1);
    const ctx = (t as { context?: string }).context;
    if (ctx) assert.ok(ctxIds.has(ctx));
  }
});

test("every tile path is a SPEC 6.1 path", () => {
  for (const t of set.tiles) {
    for (const p of usedPaths(t)) {
      assert.ok(ALLOWED_PATHS.has(p), `${t.id} uses unknown path ${p}`);
    }
  }
});

test("every check resolves missing and stale data to neutral, never green", () => {
  for (const t of set.tiles) {
    for (const c of t.checks) {
      assert.equal(c.staleState, "neutral", `${t.id} staleState`);
      assert.ok((c.staleMs ?? 0) > 0, `${t.id} staleMs must enable staleness`);
      if (c.type === "stateMatch") {
        const states = (c.map ?? []).map((m) => m.state);
        assert.ok(states.every((s) => s !== "opportunity"));
      }
    }
  }
  const link = tile("huaweiRouterLink").checks[0] as Check;
  assert.equal(link.default, "neutral");
});

test("signal tile checks rsrp and sinr with consistent zones", () => {
  const t = tile("huaweiSignal");
  const [rsrp, sinr] = t.checks as [Check, Check];
  assert.equal(rsrp.type, "zone");
  assert.equal(rsrp.path, "networking.lte.rsrp");
  assert.equal(rsrp.display, true);
  assert.equal(sinr.type, "zone");
  assert.equal(sinr.path, "networking.lte.sinr");
  assert.deepEqual(
    rsrp.zones?.map((z) => z.state),
    ["alarm", "warn", "nominal"],
  );
  assert.deepEqual(
    rsrp.zones?.map((z) => z.upper),
    [-115, -105, undefined],
  );
  assert.deepEqual(
    sinr.zones?.map((z) => z.upper),
    [0, 5, undefined],
  );
  // 10 s polling: stale after a few missed polls
  assert.ok((rsrp.staleMs as number) <= 60000);
});

test("connection tile: No service is red, other values green", () => {
  const c = tile("huaweiConnection").checks[0] as Check;
  assert.equal(c.type, "stateMatch");
  assert.equal(c.path, "networking.lte.connectionText");
  assert.deepEqual(c.map, [{ value: "No service", state: "red" }]);
  assert.equal(c.default, "green");
});

test("plan tile bands match the PlanConfig defaults", () => {
  const c = tile("huaweiPlan").checks[0] as Check;
  assert.equal(c.type, "banded");
  assert.equal(c.path, "networking.lte.plan.usedRatio");
  assert.equal(c.high?.warn, 0.8);
  assert.equal(c.high?.crit, 0.95);
  assert.deepEqual(
    tile("huaweiPlan").displayParts?.map((p) => p.path),
    ["networking.lte.plan.remainingBytes"],
  );
});

test("router link tile maps the LinkState values", () => {
  const c = tile("huaweiRouterLink").checks[0] as Check;
  const m = Object.fromEntries((c.map ?? []).map((x) => [x.value, x.state]));
  assert.equal(m.ok, "green");
  assert.equal(m.unreachable, "amber");
  assert.equal(m["auth-failed"], "red");
  assert.equal(m.connecting, "neutral");
});

test("sms tile flags unread messages as an opportunity", () => {
  const c = tile("huaweiSms").checks[0] as {
    type: string;
    path: string;
    high: { warn: number; warnState: string };
  };
  assert.equal(c.type, "banded");
  assert.equal(c.path, "networking.lte.sms.unread");
  assert.equal(c.high.warn, 0);
  assert.equal(c.high.warnState, "opportunity");
});

test("loadExamples returns the shipped file", () => {
  assert.deepEqual(loadExamples(), examples);
});

// --- provider ---

interface Methods {
  listResources(q?: unknown): Promise<Record<string, unknown>>;
  getResource(id: string): Promise<unknown>;
  setResource(id: string, v: unknown): Promise<void>;
  deleteResource(id: string): Promise<void>;
}
interface Registered {
  type: string;
  methods: Methods;
}

function fakeApp(withRegistry = true) {
  const registered: Registered[] = [];
  const errors: string[] = [];
  const debugs: string[] = [];
  const app = {
    error: (m: string) => errors.push(m),
    debug: (m: string) => debugs.push(m),
    ...(withRegistry
      ? { registerResourceProvider: (p: Registered) => registered.push(p) }
      : {}),
  } as unknown as ServerAPI;
  return { app, registered, errors, debugs };
}

test("provider registers once as statusTileExamples and is gated by running", async () => {
  const { app, registered } = fakeApp();
  const p = createTilesProvider(app, { pluginId: PLUGIN_ID });
  assert.equal(registered.length, 0);
  p.start();
  p.start();
  assert.equal(registered.length, 1);
  const reg = registered[0] as Registered;
  assert.equal(reg.type, EXAMPLES_RESOURCE_TYPE);
  assert.equal(EXAMPLES_RESOURCE_TYPE, "statusTileExamples");

  assert.deepEqual(await reg.methods.listResources(), {
    [PLUGIN_ID]: examples,
  });
  assert.deepEqual(await reg.methods.getResource(PLUGIN_ID), examples);
  await assert.rejects(reg.methods.getResource("other"));

  p.stop();
  assert.deepEqual(await reg.methods.listResources(), {});
  await assert.rejects(reg.methods.getResource(PLUGIN_ID));

  p.start();
  assert.equal(registered.length, 1);
  assert.deepEqual(await reg.methods.listResources(), {
    [PLUGIN_ID]: examples,
  });
});

test("provider is read-only", async () => {
  const { app, registered } = fakeApp();
  createTilesProvider(app, { pluginId: PLUGIN_ID }).start();
  const reg = registered[0] as Registered;
  await assert.rejects(reg.methods.setResource("x", {}), /read-only/);
  await assert.rejects(reg.methods.deleteResource("x"), /read-only/);
});

test("provider tolerates a server without registerResourceProvider", () => {
  const { app, errors, debugs } = fakeApp(false);
  const p = createTilesProvider(app, { pluginId: PLUGIN_ID });
  assert.doesNotThrow(() => p.start());
  assert.doesNotThrow(() => p.stop());
  // An older server without the registry is normal, not an error.
  assert.equal(errors.length, 0);
  assert.equal(debugs.length, 1);
});

test("provider swallows a registration failure", () => {
  const app = {
    error: () => {},
    registerResourceProvider: () => {
      throw new Error("boom");
    },
  } as unknown as ServerAPI;
  const p = createTilesProvider(app, { pluginId: PLUGIN_ID });
  assert.doesNotThrow(() => p.start());
});

// --- Status Tiles' own validator (skipped without the clone) ---

test("set validates with Status Tiles' own validator", {
  skip:
    !STATUS_TILES_DIR ||
    !existsSync(`${STATUS_TILES_DIR}/public/lib/config.js`),
}, async () => {
  const cfg = (await import(
    pathToFileURL(`${STATUS_TILES_DIR}/public/lib/config.js`).href
  )) as {
    validateConfig(c: unknown): { errors: string[]; warnings: string[] };
  };
  const ex = (await import(
    pathToFileURL(`${STATUS_TILES_DIR}/public/lib/examples.js`).href
  )) as {
    mergeIntoConfig(c: unknown, s: unknown): { merged: unknown };
  };
  for (const s of examples.sets) {
    const r = cfg.validateConfig({
      contexts: s.contexts ?? [],
      tiles: s.tiles,
    });
    assert.deepEqual(r, { errors: [], warnings: [] });
    const { merged } = ex.mergeIntoConfig({ contexts: [], tiles: [] }, s);
    assert.deepEqual(cfg.validateConfig(merged), {
      errors: [],
      warnings: [],
    });
  }
});
