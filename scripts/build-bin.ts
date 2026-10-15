/**
 * Standalone binaries via `bun build --compile`.
 * No --bytecode: on bun 1.3.6 it forces CJS and breaks top-level await.
 * No .env / bunfig autoload: a distributed CLI must not read the user's cwd config.
 *
 *   bun scripts/build-bin.ts                       # every target
 *   bun scripts/build-bin.ts darwin-arm64 linux-x64
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALL = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"] as const;
const root = join(import.meta.dir, "..");
const requested = process.argv.slice(2);
const targets = requested.length ? requested : [...ALL];

mkdirSync(join(root, "dist/bin"), { recursive: true });
let failed = 0;
for (const t of targets) {
  if (!(ALL as readonly string[]).includes(t)) {
    console.error(`unknown target ${t} (known: ${ALL.join(", ")})`);
    process.exit(2);
  }
  const outfile = join(root, "dist/bin", `pbx-${t}${t.startsWith("windows") ? ".exe" : ""}`);
  const started = performance.now();
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "src/index.ts",
      "--compile",
      "--minify",
      `--target=bun-${t}`,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      outfile,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    failed++;
    console.error(`✗ ${t}\n${proc.stderr.toString()}`);
    continue;
  }
  const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`✓ ${t.padEnd(13)} ${mb.padStart(5)} MB  ${Math.round(performance.now() - started)}ms  ${outfile}`);
}
process.exit(failed ? 1 : 0);
