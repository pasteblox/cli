/**
 * Startup benchmark (hyperfine-lite): `bun scripts/bench-startup.ts [runs]`.
 * Needs `bun run build` (and `bun run build:bin darwin-arm64` etc. for the binary row).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const runs = Number(process.argv[2] ?? 10);
const bin = join(root, `dist/bin/pbx-${process.platform}-${process.arch}`);
const env = { ...process.env, NO_COLOR: "1", PASTEBLOX_CONFIG_DIR: join(root, "dist/.bench-config") };

const cases: [string, string[]][] = [
  ["node (baseline, empty script)", ["node", "-e", ""]],
  ["node dist/pbx.js --version", ["node", "dist/pbx.js", "--version"]],
  ["node dist/pbx.js --help", ["node", "dist/pbx.js", "--help"]],
  ["node dist/pbx.js loadstring (loads zod)", ["node", "dist/pbx.js", "loadstring", "k3m9x2p7qa", "--no-copy"]],
  ["bun src/index.ts --help", [process.execPath, "src/index.ts", "--help"]],
  ...(existsSync(bin)
    ? ([
        [`${bin.split("/").pop()} --help`, [bin, "--help"]],
        [`${bin.split("/").pop()} loadstring`, [bin, "loadstring", "k3m9x2p7qa", "--no-copy"]],
      ] as [string, string[]][])
    : []),
];

for (const [label, cmd] of cases) {
  Bun.spawnSync(cmd, { cwd: root, env, stdout: "ignore", stderr: "ignore" }); // warm-up
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const r = Bun.spawnSync(cmd, { cwd: root, env, stdout: "ignore", stderr: "pipe" });
    times.push(performance.now() - t);
    if (r.exitCode !== 0) throw new Error(`${label} exited ${r.exitCode}: ${r.stderr.toString()}`);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const median = times[Math.floor(times.length / 2)] as number;
  console.log(
    `${label.padEnd(44)} mean ${mean.toFixed(1).padStart(6)} ms  median ${median.toFixed(1).padStart(6)} ms  min ${(times[0] as number).toFixed(1).padStart(6)} ms  (n=${runs})`,
  );
}
