import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PATHS, RSRP_ZONES, SINR_ZONES } from "../src/paths.ts";

// A tile's inline zones override the path's meta.zones in Status Tiles, so the
// two must describe the same bands or a gauge and its tile would disagree.

interface TileZone {
  lower?: number;
  upper?: number;
  state: string;
}

const examples = JSON.parse(
  readFileSync(
    new URL("../status-tiles-examples.json", import.meta.url),
    "utf8",
  ),
);
const tiles = examples.sets[0].tiles as {
  checks: { type: string; path: string; zones?: TileZone[] }[];
}[];

const tileZones = (path: string): TileZone[] => {
  for (const tile of tiles) {
    for (const check of tile.checks) {
      if (check.type === "zone" && check.path === path && check.zones)
        return check.zones;
    }
  }
  throw new Error(`no zone check for ${path}`);
};

// Status Tiles' "nominal" is the healthy band; the Signal K meta calls it "normal".
const severity = (state: string) => (state === "nominal" ? "normal" : state);
const shape = (zones: { lower?: number; upper?: number; state: string }[]) =>
  zones.map((z) => ({
    lower: z.lower,
    upper: z.upper,
    state: severity(z.state),
  }));

test("the signal tile's RSRP bands match the published meta zones", () => {
  assert.deepEqual(shape(tileZones(PATHS.rsrp)), shape(RSRP_ZONES));
});

test("the signal tile's SINR bands match the published meta zones", () => {
  assert.deepEqual(shape(tileZones(PATHS.sinr)), shape(SINR_ZONES));
});
