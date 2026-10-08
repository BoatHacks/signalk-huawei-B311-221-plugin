import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PLUGIN_ID } from "../src/constants.ts";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const lock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);

test("the npm package is published under the BoatHacks scope", () => {
  assert.equal(pkg.name, "@boathacks/signalk-huawei-b311-221");
});

test("a scoped package is published publicly without a flag", () => {
  assert.equal(pkg.publishConfig?.access, "public");
});

test("the lockfile carries the same name and version", () => {
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
});

test("the plugin id and its REST paths do not depend on the npm scope", () => {
  assert.equal(PLUGIN_ID, "signalk-huawei-b311-221");
});
