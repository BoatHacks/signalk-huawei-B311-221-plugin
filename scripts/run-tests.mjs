// Runs the test suite the same way on Node 20, 22 and 24, and on Windows.
//
// `node --test` only expands glob patterns itself from Node 21, and the tests
// are TypeScript, which Node runs natively only from 22.18, so this lists the
// files itself and loads TypeScript through tsx.
//
//   npm test                 all tests
//   npm test -- pollers      only test files whose name contains "pollers"

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const filters = process.argv.slice(2);

const files = readdirSync(join(root, "test"))
  .filter((name) => /\.test\.(ts|mjs)$/.test(name))
  .filter(
    (name) => filters.length === 0 || filters.some((f) => name.includes(f)),
  )
  .sort()
  .map((name) => join("test", name));

if (files.length === 0) {
  console.error(`No test files match: ${filters.join(", ")}`);
  process.exit(1);
}

const args = ["--import", "tsx", "--test"];
// The mock routers keep sockets open; force the run to end when tests finish.
if (process.allowedNodeEnvironmentFlags.has("--test-force-exit")) {
  args.push("--test-force-exit");
}
args.push(...files);

const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
