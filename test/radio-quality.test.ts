import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RSRP_GOOD_DBM,
  RSRP_POOR_DBM,
  radioQuality,
  SINR_GOOD_DB,
  SINR_POOR_DB,
} from "../src/radio-quality.ts";

test("anchors are the documented ones", () => {
  assert.equal(RSRP_POOR_DBM, -120);
  assert.equal(RSRP_GOOD_DBM, -80);
  assert.equal(SINR_POOR_DB, 0);
  assert.equal(SINR_GOOD_DB, 20);
});

test("good signal on both gives 1, poor gives 0", () => {
  assert.equal(radioQuality({ rsrp: -80, sinr: 20 }), 1);
  assert.equal(radioQuality({ rsrp: -120, sinr: 0 }), 0);
});

test("values beyond the anchors are clamped", () => {
  assert.equal(radioQuality({ rsrp: -60, sinr: 40 }), 1);
  assert.equal(radioQuality({ rsrp: -140, sinr: -10 }), 0);
});

test("linear between anchors, lower of the two wins", () => {
  // rsrp -100 -> 0.5, sinr 15 -> 0.75
  assert.equal(radioQuality({ rsrp: -100, sinr: 15 }), 0.5);
  // rsrp -85 -> 0.875, sinr 5 -> 0.25
  assert.equal(radioQuality({ rsrp: -85, sinr: 5 }), 0.25);
});

test("one input missing uses the other", () => {
  assert.equal(radioQuality({ rsrp: -100 }), 0.5);
  assert.equal(radioQuality({ sinr: 10 }), 0.5);
});

test("no usable input gives undefined, NaN is ignored", () => {
  assert.equal(radioQuality({}), undefined);
  assert.equal(radioQuality({ rsrp: Number.NaN, sinr: undefined }), undefined);
  assert.equal(radioQuality({ rsrp: Number.NaN, sinr: 10 }), 0.5);
});
