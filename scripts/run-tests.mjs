// Runs every src/**/*.test.ts with tsx (each file is a standalone script that
// sets a non-zero exit code on failure) and exits non-zero if any file failed.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".test.ts") ? [path] : [];
  });

const only = process.argv[2];
const files = walk("src").filter((f) => !only || f.includes(only)).sort();
const failed = [];
for (const file of files) {
  const run = spawnSync("npx", ["tsx", file], { encoding: "utf8" });
  const summary = (run.stdout.match(/(\d+) passed, (\d+) failed/g) ?? []).pop() ?? "no summary";
  const ok = run.status === 0 && /, 0 failed/.test(summary);
  console.log(`${ok ? "PASS" : "FAIL"}  ${file}  (${summary})`);
  if (!ok) {
    failed.push(file);
    process.stdout.write(run.stdout.split("\n").filter((l) => !l.startsWith("  ok")).join("\n"));
    process.stderr.write(run.stderr);
  }
}
console.log(failed.length ? `\n${failed.length} test file(s) failed` : `\nAll ${files.length} test files passed`);
process.exit(failed.length ? 1 : 0);
