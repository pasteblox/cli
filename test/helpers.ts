import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PKG_ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(PKG_ROOT, "src/index.ts");
const DIST = join(PKG_ROOT, "dist/pbx.js");

const BIN = join(PKG_ROOT, `dist/bin/pbx-${process.platform}-${process.arch}`);

/**
 * PBX_TEST_RUNNER=node runs the built Node bundle (dist/pbx.js), =bin the compiled binary for this
 * platform (dist/bin/pbx-<os>-<arch>); default is the TS source under bun.
 */
export const RUNNER =
  process.env.PBX_TEST_RUNNER === "node" ? "node" : process.env.PBX_TEST_RUNNER === "bin" ? "bin" : "bun";

export function command(args: string[]): string[] {
  if (RUNNER === "node") return ["node", DIST, ...args];
  if (RUNNER === "bin") return [BIN, ...args];
  return [process.execPath, ENTRY, ...args];
}

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  bin: string;
  clipboardFile: string;
  openedFile: string;
  env: Record<string, string>;
}

const created: string[] = [];
/** Call from afterAll: removes every sandbox made so far (they used to pile up in $TMPDIR). */
export function cleanupSandboxes(): void {
  if (process.env.PBX_KEEP_SANDBOXES) return;
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Fresh HOME/XDG config + project dir + fake clipboard/browser binaries first on PATH. */
export function sandbox(apiUrl: string, extraEnv: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pbx-test-"));
  created.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  for (const d of [home, project, bin]) mkdirSync(d, { recursive: true });
  const clipboardFile = join(root, "clipboard.txt");
  const openedFile = join(root, "opened.txt");
  const fake = (name: string, body: string) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  };
  for (const n of ["pbcopy", "wl-copy", "xclip", "xsel", "clip.exe"]) fake(n, `cat > "${clipboardFile}"`);
  for (const n of ["open", "xdg-open"]) fake(n, `echo "$1" >> "${openedFile}"`);

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PASTEBLOX_API: apiUrl,
    TERM: "xterm-256color",
    ...extraEnv,
  };
  return { root, home, project, bin, clipboardFile, openedFile, env };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function pbx(
  sb: Sandbox,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(command(args), {
    cwd: opts.cwd ?? sb.project,
    env: { ...sb.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export function parseJson<T = unknown>(r: RunResult): T {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`stdout is not JSON (exit ${r.code}):\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  }
}
