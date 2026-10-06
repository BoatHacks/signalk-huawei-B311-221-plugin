import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyMode, fetchMode, parseMode } from "../public/lib/mode.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const TEXT = /\.(html|js|mjs|css|svg|json|txt)$/;
// The only allowed absolute URL: the SVG XML namespace.
const ALLOWED = ["http://www.w3.org/2000/svg"];

test("public/ has no external URLs", () => {
  const files = walk(publicDir);
  assert.ok(files.length > 0);
  for (const f of files.filter((x) => TEXT.test(x))) {
    let text = readFileSync(f, "utf8");
    for (const ok of ALLOWED) text = text.split(ok).join("");
    const hits = text.match(
      /(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"')]*|https?:\/\/\S*/gi,
    );
    assert.equal(hits, null, `${relative(publicDir, f)} references ${hits}`);
  }
});

test("public/ has no CDN-style imports or innerHTML", () => {
  for (const f of walk(publicDir).filter((x) => x.endsWith(".js"))) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML/, f);
    assert.doesNotMatch(text, /from\s+["'](?!\.)/, `bare import in ${f}`);
    assert.doesNotMatch(text, /\beval\(|new Function\(/, f);
  }
});

test("index.html is a vanilla module page with day/night data-mode", () => {
  const html = readFileSync(join(publicDir, "index.html"), "utf8");
  assert.match(html, /data-mode="day"/);
  assert.match(html, /<script type="module" src="\.\/app\.js">/);
  assert.match(html, /:root\[data-mode="night"\]/);
  assert.match(html, /width=device-width/);
});

test("mode: parse, apply, fetch with fallback to day", async () => {
  assert.equal(parseMode("night"), "night");
  assert.equal(parseMode({ value: "night" }), "night");
  assert.equal(parseMode("day"), "day");
  assert.equal(parseMode("dusk"), "day");
  assert.equal(parseMode(undefined), "day");

  const doc = { documentElement: { dataset: {} } };
  applyMode("night", doc);
  assert.equal(doc.documentElement.dataset.mode, "night");
  applyMode("bogus", doc);
  assert.equal(doc.documentElement.dataset.mode, "day");

  const ok = async () => ({ ok: true, json: async () => "night" });
  assert.equal(await fetchMode(ok), "night");
  const notOk = async () => ({ ok: false, json: async () => "night" });
  assert.equal(await fetchMode(notOk), "day");
  const boom = async () => {
    throw new Error("down");
  };
  assert.equal(await fetchMode(boom), "day");
});
