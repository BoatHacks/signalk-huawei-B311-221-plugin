import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema, DEFAULTS, GB, normalizeConfig } from "../src/config.ts";

test("defaults match SPEC §9", () => {
  const { config, errors } = normalizeConfig({ password: "pw" });
  assert.deepEqual(errors, []);
  assert.equal(config.routerUrl, "http://192.168.8.1");
  assert.equal(config.username, "admin");
  assert.equal(config.signalPollSeconds, 10);
  assert.equal(config.trafficPollSeconds, 60);
  assert.equal(config.smsPollSeconds, 60);
  assert.equal(config.notifyNewSms, true);
  assert.equal(config.plan, undefined);
  assert.equal(DEFAULTS.routerUrl, "http://192.168.8.1");
});

test("a missing password is reported", () => {
  const { errors } = normalizeConfig({});
  assert.ok(errors.some((e) => /password/i.test(e)));
});

test("an empty or non-object config is handled without throwing", () => {
  for (const raw of [undefined, null, 5, "x", []]) {
    const { errors } = normalizeConfig(raw);
    assert.ok(errors.length > 0);
  }
});

test("router URL is normalised and restricted to http(s)", () => {
  assert.equal(
    normalizeConfig({ password: "p", routerUrl: "http://10.0.0.1/" }).config
      .routerUrl,
    "http://10.0.0.1",
  );
  assert.equal(
    normalizeConfig({ password: "p", routerUrl: "  http://10.0.0.1:8080  " })
      .config.routerUrl,
    "http://10.0.0.1:8080",
  );
  for (const bad of [
    "ftp://x",
    "javascript:alert(1)",
    "not a url",
    "http://",
  ]) {
    const { errors } = normalizeConfig({ password: "p", routerUrl: bad });
    assert.ok(
      errors.some((e) => /routerUrl/.test(e)),
      bad,
    );
  }
});

test("router URL credentials are rejected so they cannot leak into logs", () => {
  const { errors } = normalizeConfig({
    password: "p",
    routerUrl: "http://admin:secret@10.0.0.1",
  });
  assert.ok(errors.some((e) => /routerUrl/.test(e)));
});

test("poll intervals are clamped to safe minimums, not rejected", () => {
  const { config, errors } = normalizeConfig({
    password: "p",
    signalPollSeconds: 1,
    trafficPollSeconds: 5,
    smsPollSeconds: 0,
  });
  assert.equal(config.signalPollSeconds, 5);
  assert.equal(config.trafficPollSeconds, 30);
  assert.equal(config.smsPollSeconds, 30);
  assert.deepEqual(errors, []);
});

test("non-numeric intervals fall back to defaults", () => {
  const { config } = normalizeConfig({
    password: "p",
    signalPollSeconds: "fast",
  });
  assert.equal(config.signalPollSeconds, 10);
});

test("a plan is built from GB, percent and reset day", () => {
  const { config, errors } = normalizeConfig({
    password: "p",
    plan: { sizeGB: 50, resetDay: 15, warnPercent: 75, alarmPercent: 90 },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.plan, {
    totalBytes: 50 * GB,
    resetDay: 15,
    warnRatio: 0.75,
    alarmRatio: 0.9,
  });
});

test("plan defaults: 80% warn, 95% alarm, reset on the 1st", () => {
  const { config } = normalizeConfig({ password: "p", plan: { sizeGB: 10 } });
  assert.equal(config.plan?.warnRatio, 0.8);
  assert.equal(config.plan?.alarmRatio, 0.95);
  assert.equal(config.plan?.resetDay, 1);
});

test("a plan without a positive size disables plan tracking", () => {
  for (const plan of [
    undefined,
    {},
    { sizeGB: 0 },
    { sizeGB: -5 },
    { sizeGB: "x" },
  ]) {
    const { config, errors } = normalizeConfig({ password: "p", plan });
    assert.equal(config.plan, undefined);
    assert.deepEqual(errors, []);
  }
});

test("invalid plan fields are reported and plan tracking stays off", () => {
  for (const plan of [
    { sizeGB: 10, resetDay: 0 },
    { sizeGB: 10, resetDay: 32 },
    { sizeGB: 10, resetDay: 1.5 },
    { sizeGB: 10, warnPercent: 95, alarmPercent: 80 },
    { sizeGB: 10, warnPercent: 0 },
    { sizeGB: 10, alarmPercent: 101 },
  ]) {
    const { config, errors } = normalizeConfig({ password: "p", plan });
    assert.equal(config.plan, undefined, JSON.stringify(plan));
    assert.ok(
      errors.some((e) => /plan/i.test(e)),
      JSON.stringify(plan),
    );
  }
});

test("the schema describes every setting and marks the password as a secret", () => {
  const schema = configSchema() as {
    type: string;
    required: string[];
    properties: Record<
      string,
      { type: string; default?: unknown; format?: string; properties?: object }
    >;
  };
  assert.equal(schema.type, "object");
  assert.ok(schema.required.includes("password"));
  for (const key of [
    "routerUrl",
    "username",
    "password",
    "signalPollSeconds",
    "trafficPollSeconds",
    "smsPollSeconds",
    "notifyNewSms",
    "plan",
  ]) {
    assert.ok(schema.properties[key], key);
  }
  assert.equal(schema.properties.password?.format, "password");
  assert.equal(schema.properties.routerUrl?.default, DEFAULTS.routerUrl);
});
