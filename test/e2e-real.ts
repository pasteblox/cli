#!/usr/bin/env bun
/**
 * Real end-to-end check of `pbx` against a running pasteblox server (no mocks).
 *
 *   bun test/e2e-real.ts --api http://localhost:3301 --server-log /path/to/next.log
 *
 * --server-log  file that receives the server's stdout (MAILER=console prints magic links there)
 * --runner      node (default: dist/pbx.js, built first) | bun (src/index.ts) | bin (compiled binary)
 * --keep        don't soft-delete the scripts this run created
 *
 * Every pbx process gets a throwaway HOME/XDG_CONFIG_HOME, so the real ~/.config/pasteblox is
 * never touched. Test users and scripts are prefixed `qa-cli-`. Prints a pass/fail table and
 * exits 1 when any step fails.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ApiErrorSchema,
  DeleteScriptResponseSchema,
  GetScriptResponseSchema,
  ListScriptsResponseSchema,
  ListVersionsResponseSchema,
  UpdateScriptResponseSchema,
  VersionMetaSchema,
  WhoamiResponseSchema,
} from "@pasteblox/shared";
import { z } from "zod";

// ── args ─────────────────────────────────────────────────────────────────────

const { values: argv } = parseArgs({
  options: {
    api: { type: "string", default: "http://localhost:3301" },
    "server-log": { type: "string" },
    runner: { type: "string", default: "node" },
    keep: { type: "boolean", default: false },
  },
});
const API = (argv.api as string).replace(/\/+$/, "");
const SERVER_LOG = argv["server-log"] ? resolve(argv["server-log"] as string) : undefined;
const RUNNER = argv.runner as "node" | "bun" | "bin";
const PKG_ROOT = resolve(import.meta.dir, "..");
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const hasAnsi = (s: string) => s.includes("\u001b[");
const BROWSER_IP = `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${1 + ((Math.random() * 250) | 0)}`;

if (!SERVER_LOG) {
  console.error("--server-log <file> is required (the magic link is read from the server's stdout)");
  process.exit(2);
}

function pbxCommand(args: string[]): string[] {
  if (RUNNER === "bun") return [process.execPath, join(PKG_ROOT, "src/index.ts"), ...args];
  if (RUNNER === "bin") return [join(PKG_ROOT, `dist/bin/pbx-${process.platform}-${process.arch}`), ...args];
  return ["node", join(PKG_ROOT, "dist/pbx.js"), ...args];
}

// ── tiny harness ─────────────────────────────────────────────────────────────

type Status = "pass" | "fail" | "skip";
interface Row {
  id: string;
  name: string;
  status: Status;
  ms: number;
  detail: string;
  checks: number;
}
const rows: Row[] = [];
let checks = 0;

class Check extends Error {}
function check(cond: unknown, msg: string): asserts cond {
  checks++;
  if (!cond) throw new Check(msg);
}
function eq<T>(actual: T, expected: T, what: string): void {
  check(Object.is(actual, expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function step(id: string, name: string, needs: string[], fn: () => Promise<string | undefined>) {
  const missing = needs.filter((n) => rows.find((r) => r.id === n)?.status !== "pass");
  if (missing.length) {
    rows.push({ id, name, status: "skip", ms: 0, detail: `needs ${missing.join(", ")}`, checks: 0 });
    print(rows.at(-1) as Row);
    return;
  }
  const before = checks;
  const t0 = performance.now();
  let row: Row;
  try {
    const detail = (await fn()) ?? "";
    row = { id, name, status: "pass", ms: performance.now() - t0, detail, checks: checks - before };
  } catch (e) {
    const err = e as Error;
    const detail = e instanceof Check ? err.message : `${err.name}: ${err.message}\n${err.stack ?? ""}`;
    row = { id, name, status: "fail", ms: performance.now() - t0, detail, checks: checks - before };
  }
  rows.push(row);
  print(row);
}

function print(r: Row) {
  const mark = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
  console.log(`${mark}  ${r.id.padEnd(4)} ${r.name}  (${Math.round(r.ms)}ms)${r.detail ? `\n      ${r.detail}` : ""}`);
}

// ── sandboxes + process helpers ──────────────────────────────────────────────

interface Sandbox {
  root: string;
  home: string;
  project: string;
  configDir: string;
  clipboardFile: string;
  env: Record<string, string>;
}

const sandboxes: string[] = [];

/** Throwaway HOME + XDG config + project dir, with fake clipboard/browser commands first on PATH. */
function sandbox(label: string, extraEnv: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `qa-cli-${label}-`));
  sandboxes.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  for (const d of [home, project, bin]) mkdirSync(d, { recursive: true });
  const clipboardFile = join(root, "clipboard.txt");
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  for (const n of ["pbcopy", "wl-copy", "xclip", "xsel"]) fake(n, `cat > "${clipboardFile}"`);
  for (const n of ["open", "xdg-open"]) fake(n, "exit 0");
  return {
    root,
    home,
    project,
    configDir: join(home, ".config", "pasteblox"),
    clipboardFile,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PASTEBLOX_API: API,
      TERM: "xterm-256color",
      ...extraEnv,
    },
  };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function pbx(sb: Sandbox, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(pbxCommand(args), {
    cwd: opts.cwd ?? sb.project,
    env: { ...sb.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr } satisfies Run;
}

function okJson<T = Record<string, unknown>>(r: Run, what: string): T {
  check(r.code === 0, `${what} exited ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Check(`${what}: stdout is not JSON: ${r.stdout}`);
  }
}

function ok(r: Run, what: string): Run {
  check(r.code === 0, `${what} exited ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r;
}

/** A long-running pbx (login, watch) whose stdout we read as it arrives. */
function spawnLive(sb: Sandbox, args: string[], cwd = sb.project) {
  const proc = Bun.spawn(pbxCommand(args), {
    cwd,
    env: sb.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let out = "";
  let err = "";
  const pump = async (s: ReadableStream<Uint8Array>, sink: (t: string) => void) => {
    const dec = new TextDecoder();
    for await (const chunk of s) sink(dec.decode(chunk, { stream: true }));
  };
  const done = Promise.all([pump(proc.stdout, (t) => (out += t)), pump(proc.stderr, (t) => (err += t))]);
  return {
    proc,
    get stdout() {
      return out;
    },
    get stderr() {
      return err;
    },
    async waitFor(re: RegExp, timeoutMs: number, what: string): Promise<RegExpMatchArray> {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const m = out.match(re);
        if (m) return m;
        if (Date.now() > end || proc.exitCode !== null)
          throw new Check(`timed out waiting for ${what}\nstdout: ${out}\nstderr: ${err}`);
        await Bun.sleep(50);
      }
    },
    async exit(timeoutMs: number): Promise<number> {
      const t = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
      const code = await proc.exited;
      clearTimeout(t);
      await done;
      return code;
    },
  };
}

// ── http helpers ─────────────────────────────────────────────────────────────

interface Http {
  status: number;
  headers: Headers;
  text: string;
  bytes: Uint8Array;
  json: unknown;
}

async function http(path: string, init: RequestInit & { key?: string; jar?: Jar } = {}): Promise<Http> {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("x-api-key", init.key);
  if (init.jar) {
    headers.set("cookie", init.jar.header());
    // better-auth limits GET /api/auth/device to 5 per 15 min per IP; each run is "a new browser"
    // so the script stays repeatable (next start passes a client X-Forwarded-For through)
    headers.set("x-forwarded-for", BROWSER_IP);
  }
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("origin", API);
  const res = await fetch(`${API}${path}`, { ...init, headers, redirect: "manual" });
  init.jar?.absorb(res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, bytes, json };
}

class Jar {
  private map = new Map<string, string>();
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = (pair as string).indexOf("=");
      const name = (pair as string).slice(0, i).trim();
      const value = (pair as string).slice(i + 1).trim();
      if (value === "" || /max-age=0/i.test(c)) this.map.delete(name);
      else this.map.set(name, value);
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  has(re: RegExp) {
    return [...this.map.keys()].some((k) => re.test(k));
  }
}

/** Sign in with a magic link, reading the link from the server's console mailer output. */
async function signIn(email: string): Promise<Jar> {
  const offset = existsSync(SERVER_LOG as string) ? statSync(SERVER_LOG as string).size : 0;
  const jar = new Jar();
  const r = await http("/api/auth/sign-in/magic-link", {
    method: "POST",
    body: JSON.stringify({ email, callbackURL: "/" }),
    jar,
  });
  check(r.status === 200, `magic-link request → ${r.status} ${r.text}`);
  const esc = email.replace(/[.+]/g, "\\$&");
  const re = new RegExp(`MAGIC LINK for ${esc}\\s+(\\S+)`);
  let link: string | undefined;
  for (let i = 0; i < 100 && !link; i++) {
    // offset is in bytes (the log is full of multi-byte box characters): slice before decoding
    const log = readFileSync(SERVER_LOG as string)
      .subarray(offset)
      .toString("utf8");
    link = log.match(re)?.[1];
    if (!link) await Bun.sleep(100);
  }
  check(link, `no magic link for ${email} in ${SERVER_LOG}`);
  const url = new URL(link);
  check(url.origin === API, `magic link points at ${url.origin}, not ${API}`);
  const v = await http(`${url.pathname}${url.search}`, { jar });
  check(
    v.status === 302 || v.status === 303 || v.status === 307,
    `magic-link verify → ${v.status} ${v.text.slice(0, 200)}`,
  );
  check(jar.has(/session_token/), "no session cookie after magic-link verify");
  return jar;
}

/** What the /device page does: claim the code with the session, then approve it. */
async function approveDevice(jar: Jar, userCode: string) {
  const v = await http(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, { jar });
  check(v.status === 200, `GET /api/auth/device → ${v.status} ${v.text}`);
  eq((v.json as { status?: string }).status, "pending", "device code status");
  const a = await http("/api/auth/device/approve", { method: "POST", body: JSON.stringify({ userCode }), jar });
  check(a.status === 200, `POST /api/auth/device/approve → ${a.status} ${a.text}`);
}

/** Full `pbx login --no-browser` with the browser side done over HTTP. */
async function login(sb: Sandbox, jar: Jar, json = false, beforeApprove?: (proc: Bun.Subprocess) => Promise<void>) {
  const live = spawnLive(sb, ["login", "--api", API, "--no-browser", ...(json ? ["--json"] : [])]);
  let userCode: string;
  let verifyUrl: string;
  if (json) {
    // --json streams one object per line: device_code first, logged_in last
    const m = await live.waitFor(/^(\{"event":"device_code".*\})$/m, 15_000, "the device_code event");
    const ev = JSON.parse(m[1] as string) as { userCode: string; verificationUri: string; expiresIn: number };
    userCode = ev.userCode;
    verifyUrl = ev.verificationUri;
    check(ev.expiresIn > 0, "device_code expiresIn");
  } else {
    // the code is printed letter-spaced inside a box: │   7 Q Q P - K 8 6 P   │
    const codeM = await live.waitFor(/│\s+((?:[A-Z0-9] ){4}- (?:[A-Z0-9] ){3}[A-Z0-9])\s+│/, 15_000, "the user code");
    const urlM = await live.waitFor(/confirm this code at (\S+)/, 5_000, "the verification url");
    userCode = (codeM[1] as string).replace(/ /g, "");
    verifyUrl = urlM[1] as string;
  }
  check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode), `user code ${userCode}`);
  check(verifyUrl.startsWith(`${API}/device`), `verification url ${verifyUrl} isn't ${API}/device…`);
  eq(new URL(verifyUrl).searchParams.get("user_code"), userCode.replace("-", ""), "user_code in the url");
  if (beforeApprove) await beforeApprove(live.proc);
  await approveDevice(jar, userCode);
  const code = await live.exit(45_000);
  check(code === 0, `pbx login exited ${code}\nstdout: ${live.stdout}\nstderr: ${live.stderr}`);
  return { stdout: live.stdout, stderr: live.stderr, userCode, verifyUrl };
}

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const mode = (p: string) => statSync(p).mode & 0o777;
const read = (p: string) => readFileSync(p, "utf8");

async function versionsOf(slug: string, key: string) {
  const r = await http(`/api/v1/scripts/${slug}/versions?limit=100`, { key });
  check(r.status === 200, `GET versions ${slug} → ${r.status} ${r.text}`);
  return ListVersionsResponseSchema.parse(r.json).items;
}

// ── shared state between steps ───────────────────────────────────────────────

const email = `qa-cli-${RUN_ID}@example.test`;
let jar: Jar;
let apiKey = "";
let handle = "";
const sb = sandbox("main");
const P = (f: string) => join(sb.project, f);
const FILE_A = "src/qa-cli-alpha.luau";
const FILE_B = "src/qa-cli-beta.luau";
const A1 = `-- qa-cli alpha ${RUN_ID}\nlocal Players = game:GetService("Players")\nprint("alpha v1", #Players:GetPlayers())\n`;
const A2 = `${A1}print("alpha v2 ✓ ünïcode")\n`;
const B1 = `-- qa-cli beta ${RUN_ID}\nreturn function(x)\n\treturn x * 2\nend\n`;
let slugA = "";
let slugB = "";
let slugPrivate = "";
let slugAnon = "";
const created: string[] = [];
let ciKey = "";

// ── steps ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`pbx real e2e · api ${API} · runner ${RUNNER} · run ${RUN_ID}\n`);

  const health = await fetch(`${API}/api/v1/me`).catch(() => null);
  if (!health) {
    console.error(`can't reach ${API}; start the server first`);
    process.exit(1);
  }

  if (RUNNER === "node") {
    const b = Bun.spawnSync(["bun", "run", "build"], { cwd: PKG_ROOT, stdout: "pipe", stderr: "pipe" });
    if (b.exitCode !== 0) {
      console.error(`bun run build failed:\n${b.stderr.toString()}`);
      process.exit(1);
    }
  }

  await step("1", "login (device flow) → key 0600 → whoami", [], async () => {
    jar = await signIn(email);
    const res = await login(sb, jar);
    check(/logged in as @/.test(res.stdout), `no "logged in as" line: ${res.stdout}`);
    const cfgPath = join(sb.configDir, "config.json");
    check(existsSync(cfgPath), `${cfgPath} not written`);
    eq(mode(cfgPath), 0o600, "config.json mode");
    eq(mode(sb.configDir), 0o700, "config dir mode");
    const cfg = JSON.parse(read(cfgPath)) as { hosts: Record<string, { apiKey: string; user: { handle: string } }> };
    const entry = cfg.hosts[API];
    check(entry, `no host entry for ${API} in config.json (keys: ${Object.keys(cfg.hosts)})`);
    check(entry.apiKey.startsWith("pbx_"), `stored key doesn't start with pbx_`);
    apiKey = entry.apiKey;
    handle = entry.user.handle;
    check(handle.startsWith("qa-cli-"), `handle ${handle} not derived from the email`);
    // the device-flow bearer session is revoked by /cli/exchange: only the browser session is left
    const sessions = await http("/api/auth/list-sessions", { jar });
    eq(sessions.status, 200, "list-sessions status");
    eq((sessions.json as unknown[]).length, 1, "sessions left after the key exchange");

    const who = ok(await pbx(sb, ["whoami"]), "pbx whoami");
    check(who.stdout.includes(`@${handle}`), `whoami doesn't show @${handle}: ${who.stdout}`);
    check(/api key "pbx on /.test(who.stdout), `whoami doesn't name the cli key: ${who.stdout}`);
    const wj = okJson<{ user: unknown; auth: { method: string }; source: string }>(
      await pbx(sb, ["whoami", "--json"]),
      "whoami --json",
    );
    WhoamiResponseSchema.parse({ user: wj.user, auth: wj.auth });
    eq(wj.auth.method, "api_key", "whoami auth.method");
    eq(wj.source, "config", "whoami source");
    // a second login without --force is a no-op
    const again = ok(await pbx(sb, ["login", "--no-browser"]), "second pbx login");
    check(/already logged in/.test(again.stdout), `second login didn't say already logged in: ${again.stdout}`);
    return `@${handle}, code ${res.userCode}`;
  });

  await step("2", "init (non-interactive) → pasteblox.json", [], async () => {
    mkdirSync(P("src"), { recursive: true });
    writeFileSync(P(FILE_A), A1);
    writeFileSync(P(FILE_B), B1);
    const bare = await pbx(sb, ["init"]);
    eq(bare.code, 2, "pbx init without --yes/-f outside a tty exit code");
    const j = okJson<{ added: { file: string }[] }>(await pbx(sb, ["init", "--yes", "--json"]), "pbx init --yes");
    eq(j.added.length, 2, "files added");
    const pj = JSON.parse(read(P("pasteblox.json"))) as { $schema: string; scripts: { file: string; slug?: string }[] };
    eq(pj.$schema, "https://pasteblox.com/schema/pasteblox.json", "$schema");
    eq(pj.scripts.map((s) => s.file).join(","), `${FILE_A},${FILE_B}`, "mapped files");
    check(
      pj.scripts.every((s) => !s.slug),
      "init shouldn't invent slugs",
    );
    const schema = await http("/schema/pasteblox.json");
    eq(schema.status, 200, "GET /schema/pasteblox.json");
    return "2 files mapped";
  });

  await step("3", "push creates → push unchanged → edit → push -m → v2", ["1", "2"], async () => {
    type PushOut = {
      pushed: { file: string; slug: string; version: number; created: boolean; unchanged: boolean }[];
      skipped: { file: string; reason: string }[];
      errors: unknown[];
    };
    const first = okJson<PushOut>(await pbx(sb, ["push", "--json"]), "first pbx push");
    eq(first.pushed.length, 2, "pushed on first push");
    check(
      first.pushed.every((p) => p.created && p.version === 1),
      `first push: ${JSON.stringify(first.pushed)}`,
    );
    slugA = first.pushed.find((p) => p.file === FILE_A)?.slug ?? "";
    slugB = first.pushed.find((p) => p.file === FILE_B)?.slug ?? "";
    created.push(slugA, slugB);
    const pj = JSON.parse(read(P("pasteblox.json"))) as { scripts: { file: string; slug?: string }[] };
    eq(pj.scripts.find((s) => s.file === FILE_A)?.slug, slugA, "slug written back to pasteblox.json");

    // warm the raw cache on v1 so step 4 proves invalidation
    const warm = await http(`/raw/${slugA}`);
    eq(warm.text, A1, "raw after first push");

    const second = okJson<PushOut>(await pbx(sb, ["push", "--json"]), "second pbx push");
    eq(second.pushed.length, 0, "pushed on unchanged push");
    eq(second.skipped.length, 2, "skipped on unchanged push");
    const human = ok(await pbx(sb, ["push"]), "unchanged pbx push (text)");
    check(/up to date/.test(human.stdout), `unchanged push should say up to date: ${human.stdout}`);
    // explicit file → server-side dedupe by sha256
    const explicit = okJson<PushOut>(await pbx(sb, ["push", FILE_A, "--json"]), "pbx push <file> unchanged");
    check(
      explicit.pushed[0]?.unchanged === true && explicit.pushed[0]?.version === 1,
      `explicit unchanged push: ${JSON.stringify(explicit.pushed)}`,
    );
    eq((await versionsOf(slugA, apiKey)).length, 1, "versions after unchanged pushes");

    writeFileSync(P(FILE_A), A2);
    const third = okJson<PushOut>(await pbx(sb, ["push", "-m", "qa-cli second", "--json"]), "pbx push -m");
    eq(third.pushed.length, 1, "pushed after edit");
    eq(third.pushed[0]?.version, 2, "new version");
    eq(third.skipped.length, 1, "skipped after edit");
    const vs = await versionsOf(slugA, apiKey);
    eq(vs.map((v) => v.n).join(","), "2,1", "version list");
    eq(vs[0]?.message, "qa-cli second", "v2 message");
    eq(vs[0]?.source, "cli", "v2 source");
    eq(vs[0]?.author?.handle, handle, "v2 author");
    return `${slugA}, ${slugB}`;
  });

  await step("4", "raw: fresh v2, @1 pinned, headers, ETag/304", ["3"], async () => {
    const latest = await http(`/raw/${slugA}`);
    eq(latest.status, 200, "raw latest status");
    eq(sha(latest.bytes), sha(A2), "raw latest bytes == v2 (no stale cache)");
    const h = latest.headers;
    eq(h.get("content-type"), "text/plain; charset=utf-8", "content-type");
    eq(h.get("x-content-type-options"), "nosniff", "x-content-type-options");
    eq(h.get("content-security-policy"), "default-src 'none'; sandbox", "csp");
    eq(h.get("cache-control"), "public, max-age=0, must-revalidate", "latest cache-control");
    eq(h.get("x-pasteblox-version"), "2", "x-pasteblox-version");
    eq(h.get("access-control-allow-origin"), "*", "cors");
    eq(h.get("content-disposition"), `inline; filename="${slugA}.luau"`, "content-disposition");
    check(!(h.get("cache-control") ?? "").includes("stale-while-revalidate"), "no SWR");
    check(!h.get("set-cookie"), "raw must not set cookies");
    const etag = h.get("etag");
    eq(etag, `"${sha(A2)}"`, "etag is the content sha256");

    const nm = await http(`/raw/${slugA}`, { headers: { "if-none-match": etag as string } });
    eq(nm.status, 304, "If-None-Match → 304");
    eq(nm.bytes.length, 0, "304 body length");

    const pinned = await http(`/raw/${slugA}@1`);
    eq(pinned.status, 200, "@1 status");
    eq(pinned.text, A1, "@1 body == v1");
    eq(pinned.headers.get("cache-control"), "public, max-age=31536000, immutable", "pinned cache-control");
    eq(pinned.headers.get("x-pasteblox-version"), "1", "pinned version header");
    const alias = await http(`/raw/${slugA}/v1`);
    eq(alias.text, A1, "/raw/<slug>/v1 alias");

    const missing = await http(`/raw/${slugA}@9`);
    eq(missing.status, 404, "@9 status");
    check(/^error\(/.test(missing.text) && missing.text.includes("latest is 2"), `@9 body: ${missing.text}`);
    const head = await http(`/raw/${slugA}`, { method: "HEAD" });
    eq(head.status, 200, "HEAD status");
    return `etag ${etag?.slice(1, 9)}…`;
  });

  await step("4b", "raw is fresh back-to-back (0 ms) after push/PATCH/DELETE/restore", ["1"], async () => {
    // The CLI's process startup hides races; an API client that pushes and immediately fetches
    // doesn't. Each check below runs with no delay between the write response and the read.
    const h = { "x-api-key": apiKey };
    const c = await http("/api/v1/scripts", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ content: "print(0)\n", title: `qa-cli-fresh ${RUN_ID}` }),
    });
    eq(c.status, 201, "create");
    const slug = (c.json as { script: { slug: string } }).script.slug;
    created.push(slug);
    let stale = 0;
    for (let i = 1; i <= 8; i++) {
      await http(`/raw/${slug}`); // warm the cache on the previous version
      const body = `print(${i})\n`;
      const p = await http(`/api/v1/scripts/${slug}/versions`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ content: body }),
      });
      eq(p.status, 201, `push ${i}`);
      if ((await http(`/raw/${slug}`)).text !== body) stale++;
    }
    eq(stale, 0, "stale raw reads right after a push (of 8)");
    const patch = (visibility: string) =>
      http(`/api/v1/scripts/${slug}`, { method: "PATCH", headers: h, body: JSON.stringify({ visibility }) });
    eq((await patch("private")).status, 200, "PATCH private");
    eq((await http(`/raw/${slug}`)).status, 404, "raw right after PATCH private");
    eq((await patch("unlisted")).status, 200, "PATCH unlisted");
    eq((await http(`/raw/${slug}`)).status, 200, "raw right after PATCH unlisted");
    eq((await http(`/api/v1/scripts/${slug}`, { method: "DELETE", headers: h })).status, 200, "DELETE");
    eq((await http(`/raw/${slug}`)).status, 404, "raw right after DELETE");
    eq((await http(`/api/v1/scripts/${slug}/restore`, { method: "POST", headers: h })).status, 200, "restore");
    eq((await http(`/raw/${slug}`)).status, 200, "raw right after restore");
    return "8 pushes + visibility + delete/restore, 0 stale";
  });

  await step("5", "pull --version 1 -o; refuses to clobber local edits", ["3"], async () => {
    const j = okJson<{ version: number; written: boolean; latestVersion: number }>(
      await pbx(sb, ["pull", slugA, "--version", "1", "-o", "other.luau", "--json"]),
      "pbx pull --version 1",
    );
    eq(j.version, 1, "pulled version");
    eq(j.latestVersion, 2, "latestVersion");
    eq(read(P("other.luau")), A1, "other.luau == v1");

    const edited = `${B1}-- local edit\n`;
    writeFileSync(P(FILE_B), edited);
    const refused = await pbx(sb, ["pull", slugB]);
    eq(refused.code, 1, "pull over local changes exit code");
    check(/local changes/.test(refused.stderr), `refusal message: ${refused.stderr}`);
    eq(read(P(FILE_B)), edited, "local file untouched after refusal");
    ok(await pbx(sb, ["pull", slugB, "--force"]), "pbx pull --force");
    eq(read(P(FILE_B)), B1, "file after pull --force");
    const same = ok(await pbx(sb, ["pull", slugB]), "pbx pull when already up to date");
    check(/already matches/.test(same.stdout), `up-to-date pull: ${same.stdout}`);
    return undefined;
  });

  await step("6", "log, diff (local + --from/--to), ls, loadstring --json", ["3"], async () => {
    const log = ok(await pbx(sb, ["log", slugA]), "pbx log");
    const lines = log.stdout.trim().split("\n");
    check(lines[0]?.startsWith("v2") && lines[0].includes("qa-cli second"), `log line 1: ${lines[0]}`);
    check(lines[1]?.startsWith("v1"), `log line 2: ${lines[1]}`);
    const lj = okJson<{ slug: string; versions: unknown[]; nextCursor: null }>(
      await pbx(sb, ["log", slugA, "--json"]),
      "pbx log --json",
    );
    const vs = z.array(VersionMetaSchema).parse(lj.versions);
    eq(vs.map((v) => v.n).join(","), "2,1", "log --json order");

    writeFileSync(P(FILE_A), `${A2}print("local only")\n`);
    const d = ok(await pbx(sb, ["diff", slugA]), "pbx diff (local)");
    check(d.stdout.includes(`--- a/${slugA}@2`), `diff old label: ${d.stdout}`);
    check(d.stdout.includes(`+++ b/${FILE_A}`), `diff new label: ${d.stdout}`);
    check(d.stdout.includes('+print("local only")'), `diff body: ${d.stdout}`);
    const dj = okJson<{ changed: boolean; added: number; removed: number; to: { file: string } }>(
      await pbx(sb, ["diff", slugA, "--json"]),
      "pbx diff --json",
    );
    check(
      dj.changed && dj.added === 1 && dj.removed === 0 && dj.to.file === FILE_A,
      `diff --json: ${JSON.stringify(dj)}`,
    );
    writeFileSync(P(FILE_A), A2);
    const clean = ok(await pbx(sb, ["diff", FILE_A]), "pbx diff <file> (clean)");
    check(/no changes/.test(clean.stdout + clean.stderr), `clean diff: ${clean.stdout}${clean.stderr}`);

    const vv = okJson<{ from: { version: number }; to: { version: number }; patch: string; added: number }>(
      await pbx(sb, ["diff", slugA, "--from", "1", "--to", "2", "--json"]),
      "pbx diff --from 1 --to 2",
    );
    check(vv.from.version === 1 && vv.to.version === 2 && vv.added === 1, `version diff: ${JSON.stringify(vv)}`);
    check(vv.patch.includes('+print("alpha v2 ✓ ünïcode")'), `version diff patch: ${vv.patch}`);

    const ls = okJson<{ scripts: unknown[]; nextCursor: string | null }>(
      await pbx(sb, ["ls", "--json"]),
      "pbx ls --json",
    );
    const items = ListScriptsResponseSchema.parse({ items: ls.scripts, nextCursor: ls.nextCursor }).items;
    for (const s of [slugA, slugB])
      check(
        items.some((i) => i.slug === s),
        `ls missing ${s}`,
      );
    eq(items.find((i) => i.slug === slugA)?.latestVersion, 2, "ls latestVersion");
    const lsText = ok(await pbx(sb, ["ls"]), "pbx ls");
    check(lsText.stdout.includes(slugA) && /title\s+slug/.test(lsText.stdout), `ls table: ${lsText.stdout}`);

    const lj2 = okJson<{ slug: string; version: number | null; url: string; loadstring: string; copied: boolean }>(
      await pbx(sb, ["loadstring", slugA, "--json"]),
      "pbx loadstring --json",
    );
    eq(lj2.url, `${API}/raw/${slugA}`, "loadstring url");
    eq(lj2.loadstring, `loadstring(game:HttpGet("${API}/raw/${slugA}"))()`, "loadstring line");
    eq(lj2.version, null, "loadstring version");
    eq(lj2.copied, true, "copied (fake pbcopy)");
    eq(read(sb.clipboardFile), lj2.loadstring, "clipboard content");
    const pin = okJson<{ url: string }>(
      await pbx(sb, ["loadstring", `${slugA}@1`, "--json", "--no-copy"]),
      "pbx loadstring slug@1",
    );
    eq(pin.url, `${API}/raw/${slugA}@1`, "pinned loadstring url");
    return undefined;
  });

  await step("7", "watch: 2 quick saves → 1 push; SIGINT → exit 0", ["3"], async () => {
    const before = (await versionsOf(slugB, apiKey))[0]?.n ?? 0;
    const live = spawnLive(sb, ["watch", "--json"]);
    await live.waitFor(/"event":"watching"/, 10_000, "the watching event");
    await Bun.sleep(300); // let fs.watch settle
    writeFileSync(P(FILE_B), `${B1}-- watch 1\n`);
    await Bun.sleep(60);
    const B3 = `${B1}-- watch 2\n`;
    writeFileSync(P(FILE_B), B3);
    await live.waitFor(/"event":"push"/, 10_000, "a push event");
    await Bun.sleep(1500); // a second (wrong) push would land in this window
    live.proc.kill("SIGINT");
    const code = await live.exit(5_000);
    eq(code, 0, "watch exit code after SIGINT");
    const events = live.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; version?: number; file?: string });
    const pushes = events.filter((e) => e.event === "push");
    eq(pushes.length, 1, `push events (${live.stdout})`);
    eq(pushes[0]?.version, before + 1, "pushed version");
    check(events.at(-1)?.event === "stopped", `last event: ${JSON.stringify(events.at(-1))}`);
    const vs = await versionsOf(slugB, apiKey);
    eq(vs[0]?.n, before + 1, "latest version via api");
    check(vs[0]?.message.startsWith("watch: "), `watch version message: ${vs[0]?.message}`);
    eq((await http(`/raw/${slugB}`)).text, B3, "raw after watch push");
    return `v${before} → v${before + 1}`;
  });

  await step("8", "--private: raw 404 for anon, owner pull works; flip back", ["3"], async () => {
    const SECRET = `-- qa-cli secret ${RUN_ID}\nprint("shh")\n`;
    writeFileSync(P("qa-cli-secret.luau"), SECRET);
    const j = okJson<{ pushed: { slug: string; visibility: string; created: boolean }[] }>(
      await pbx(sb, ["push", "qa-cli-secret.luau", "--private", "--json"]),
      "pbx push --private",
    );
    slugPrivate = j.pushed[0]?.slug ?? "";
    created.push(slugPrivate);
    eq(j.pushed[0]?.visibility, "private", "visibility");
    const raw = await http(`/raw/${slugPrivate}`);
    eq(raw.status, 404, "anonymous raw of a private script");
    check(raw.text.startsWith("error(") && !raw.text.includes("shh"), `private raw body: ${raw.text}`);
    eq((await http(`/raw/${slugPrivate}@1`)).status, 404, "anonymous pinned raw of a private script");
    eq((await http(`/api/v1/scripts/${slugPrivate}`)).status, 404, "anonymous api GET of a private script");
    const pulled = okJson<{ version: number }>(
      await pbx(sb, ["pull", slugPrivate, "-o", "pulled-secret.luau", "--json"]),
      "owner pbx pull of a private script",
    );
    eq(pulled.version, 1, "pulled version");
    eq(read(P("pulled-secret.luau")), SECRET, "pulled private content");

    // an existing (cached!) unlisted script turned private and back
    ok(await pbx(sb, ["push", FILE_A, "--private"]), "pbx push <mapped> --private");
    eq((await http(`/raw/${slugA}`)).status, 404, "raw after flipping alpha to private");
    ok(await pbx(sb, ["push", FILE_A, "--unlisted"]), "pbx push <mapped> --unlisted");
    const back = await http(`/raw/${slugA}`);
    eq(back.status, 200, "raw after flipping alpha back to unlisted");
    eq(back.text, A2, "raw body after flipping back");
    return slugPrivate;
  });

  await step("9", "PASTEBLOX_TOKEN (CI key) in a fresh HOME → ls", ["1", "3"], async () => {
    const r = await http("/api/auth/api-key/create", {
      method: "POST",
      body: JSON.stringify({ name: `qa-cli ci ${RUN_ID}`, metadata: { kind: "ci" } }),
      jar,
    });
    check(r.status === 200, `api-key/create → ${r.status} ${r.text}`);
    ciKey = (r.json as { key: string }).key;
    check(ciKey?.startsWith("pbx_"), "ci key prefix");
    const ci = sandbox("ci", { PASTEBLOX_TOKEN: ciKey });
    check(!existsSync(join(ci.configDir, "config.json")), "fresh HOME has no config");
    const ls = okJson<{ scripts: { slug: string }[] }>(await pbx(ci, ["ls", "--json"]), "PASTEBLOX_TOKEN pbx ls");
    check(
      ls.scripts.some((s) => s.slug === slugA),
      "ci ls sees the user's scripts",
    );
    const who = ok(await pbx(ci, ["whoami"]), "PASTEBLOX_TOKEN pbx whoami");
    check(who.stdout.includes("from PASTEBLOX_TOKEN"), `whoami source: ${who.stdout}`);
    const bad = await pbx(ci, ["ls"], { env: { PASTEBLOX_TOKEN: "pbx_definitelynotakey" } });
    eq(bad.code, 1, "bogus PASTEBLOX_TOKEN exit code");
    check(/PASTEBLOX_TOKEN was rejected/.test(bad.stderr), `bogus token message: ${bad.stderr}`);
    return `${ls.scripts.length} scripts`;
  });

  await step("x1", "concurrency: remote push → conflict → pull/--force", ["3", "9"], async () => {
    // someone else (CI) pushes to slugA from another checkout
    const ci = sandbox("ci2", { PASTEBLOX_TOKEN: ciKey });
    const REMOTE = `${A2}print("remote edit")\n`;
    writeFileSync(join(ci.project, "alpha.luau"), REMOTE);
    const r = okJson<{ pushed: { version: number }[] }>(
      await pbx(ci, ["push", "alpha.luau", "--slug", slugA, "--json"]),
      "ci push --slug",
    );
    eq(r.pushed[0]?.version, 3, "remote version");
    // this machine is still based on v2
    const LOCAL = `${A2}print("local edit")\n`;
    writeFileSync(P(FILE_A), LOCAL);
    const conflict = await pbx(sb, ["push"]);
    eq(conflict.code, 1, "conflicting push exit code");
    check(
      conflict.stderr.includes(`remote moved on: ${slugA} is at v3, you're based on v2`),
      `conflict message: ${conflict.stderr}`,
    );
    eq((await versionsOf(slugA, apiKey))[0]?.n, 3, "no version created by the conflicting push");
    const forced = okJson<{ pushed: { version: number }[] }>(
      await pbx(sb, ["push", "--force", "--json"]),
      "push --force",
    );
    eq(forced.pushed[0]?.version, 4, "forced version");
    eq((await http(`/raw/${slugA}`)).text, LOCAL, "raw after --force");
    // and the other side catches up with pull --force
    const pulled = okJson<{ version: number }>(
      await pbx(ci, ["pull", slugA, "-o", "alpha.luau", "--force", "--json"]),
      "ci pull --force",
    );
    eq(pulled.version, 4, "ci pulled version");
    eq(read(join(ci.project, "alpha.luau")), LOCAL, "ci file after pull --force");
    writeFileSync(P(FILE_A), A2);
    ok(await pbx(sb, ["push", "-m", "back to v2 content"]), "push back");
    return "v2 → remote v3 → conflict → --force v4";
  });

  await step("x2", "content fidelity: CRLF/.lua, 500 KB, size limit, safety warn, log paging", ["3"], async () => {
    const CRLF = "-- qa-cli crlf\r\nprint('a')\r\n\tprint(\"tab\")  \r\nreturn 1";
    writeFileSync(P("qa-cli-crlf.lua"), CRLF);
    const c = okJson<{ pushed: { slug: string }[] }>(await pbx(sb, ["push", "qa-cli-crlf.lua", "--json"]), "push crlf");
    const crlfSlug = c.pushed[0]?.slug ?? "";
    created.push(crlfSlug);
    const raw = await http(`/raw/${crlfSlug}`);
    eq(sha(raw.bytes), sha(CRLF), "CRLF bytes round trip through raw");
    eq(raw.headers.get("content-disposition"), `inline; filename="${crlfSlug}.lua"`, ".lua filename");
    ok(await pbx(sb, ["pull", crlfSlug, "-o", "crlf-copy.lua"]), "pull crlf");
    eq(sha(readFileSync(P("crlf-copy.lua"))), sha(CRLF), "CRLF bytes round trip through pull");

    const line = `local t = "${"x".repeat(96)}" -- ü\n`; // 106 bytes, 1 multi-byte char
    const BIG = line.repeat(Math.floor(500_000 / Buffer.byteLength(line)));
    writeFileSync(P("qa-cli-big.luau"), BIG);
    const b = okJson<{ pushed: { slug: string; sizeBytes: number }[] }>(
      await pbx(sb, ["push", "qa-cli-big.luau", "--json"]),
      "push 500 KB",
    );
    created.push(b.pushed[0]?.slug ?? "");
    eq(b.pushed[0]?.sizeBytes, Buffer.byteLength(BIG), "sizeBytes");
    eq(sha((await http(`/raw/${b.pushed[0]?.slug}`)).bytes), sha(BIG), "500 KB raw bytes");
    writeFileSync(P("qa-cli-huge.luau"), line.repeat(6000));
    const huge = await pbx(sb, ["push", "qa-cli-huge.luau"]);
    eq(huge.code, 1, "over-limit push exit code");
    check(/over the 512/.test(huge.stderr), `over-limit message: ${huge.stderr}`);

    writeFileSync(
      P("qa-cli-hook.luau"),
      'local url = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz"\nprint(url)\n',
    );
    const hook = ok(await pbx(sb, ["push", "qa-cli-hook.luau"]), "push with webhook");
    const hookSlug = /slug\s+([a-z0-9]{10})/.exec(hook.stdout)?.[1] ?? "";
    created.push(hookSlug);
    check(/discord webhook/.test(hook.stderr), `no webhook warning: ${hook.stdout}${hook.stderr}`);

    const page = okJson<{ versions: unknown[]; nextCursor: string | null }>(
      await pbx(sb, ["log", slugA, "-n", "1", "--json"]),
      "log -n 1",
    );
    eq(page.versions.length, 1, "log -n 1 length");
    check(page.nextCursor, "log -n 1 has a nextCursor");
    const all = okJson<{ versions: { n: number }[] }>(await pbx(sb, ["log", slugA, "--json"]), "log all");
    eq(all.versions.map((v) => v.n).join(","), "5,4,3,2,1", "full history");
    return undefined;
  });

  await step("x3", "login keeps polling through better-auth 429s", ["1"], async () => {
    // better-auth's in-memory limiter allows 100 POST /device/token per IP per 10 s of activity
    // (it answers {"message":"Too many requests…"} + X-Retry-After, not an RFC 8628 error).
    // Hold that bucket shut for 12 s while pbx polls; pbx must back off, not abort.
    const x = sandbox("x3");
    let limited = 0;
    const res = await login(x, jar, true, async (proc) => {
      const until = Date.now() + 12_000;
      while (Date.now() < until && proc.exitCode === null) {
        const r = await fetch(`${API}/api/auth/device/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (r.status === 429) limited++;
        await r.text();
        await Bun.sleep(20);
      }
    });
    check(limited > 0, "the limiter never kicked in (is rate limiting on? next start = production)");
    check(res.stdout.includes('"event":"logged_in"'), `no logged_in event: ${res.stdout}`);
    ok(await pbx(x, ["logout"]), "logout x3");
    return `${limited} × 429 absorbed`;
  });

  await step("10", "anonymous push → claim token → login claims it", ["1"], async () => {
    const anon = sandbox("anon");
    const ANON = `-- qa-cli anon ${RUN_ID}\nprint("hi")\n`;
    writeFileSync(join(anon.project, "qa-cli-anon.luau"), ANON);
    const notLogged = await pbx(anon, ["ls"]);
    eq(notLogged.code, 1, "logged-out ls exit code");
    const j = okJson<{ pushed: { slug: string; anonymous: boolean; created: boolean }[] }>(
      await pbx(anon, ["push", "qa-cli-anon.luau", "--json"]),
      "anonymous pbx push",
    );
    slugAnon = j.pushed[0]?.slug ?? "";
    created.push(slugAnon);
    check(j.pushed[0]?.anonymous && j.pushed[0]?.created, `anon push: ${JSON.stringify(j.pushed)}`);
    const claims = join(anon.configDir, "claims.json");
    eq(mode(claims), 0o600, "claims.json mode");
    check(read(claims).includes(slugAnon), "claims.json has the slug");
    const meta0 = GetScriptResponseSchema.parse((await http(`/api/v1/scripts/${slugAnon}`)).json);
    eq(meta0.script.owner, null, "owner before login");
    eq(meta0.script.visibility, "unlisted", "anonymous visibility");

    // the claim token also lets the anonymous author push again
    writeFileSync(join(anon.project, "qa-cli-anon.luau"), `${ANON}print("v2")\n`);
    const j2 = okJson<{ pushed: { version: number }[] }>(await pbx(anon, ["push", "--json"]), "anonymous re-push");
    eq(j2.pushed[0]?.version, 2, "anonymous v2");

    const res = await login(anon, jar, true);
    const events = res.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; claimed?: string[]; user?: { handle: string } });
    eq(events.map((e) => e.event).join(","), "device_code,logged_in", "login --json events");
    eq(events[1]?.claimed?.join(","), slugAnon, "claimed slugs");
    eq(events[1]?.user?.handle, handle, "logged_in user");
    check(!existsSync(claims), "claims.json removed after claiming");
    const meta = GetScriptResponseSchema.parse((await http(`/api/v1/scripts/${slugAnon}`, { key: apiKey })).json);
    eq(meta.script.owner?.handle, handle, "owner after login");
    eq(meta.script.viewer.canEdit, true, "owner canEdit");
    // the logged-in machine can keep pushing it
    writeFileSync(join(anon.project, "qa-cli-anon.luau"), `${ANON}print("v3")\n`);
    const j3 = okJson<{ pushed: { version: number; anonymous: boolean }[] }>(
      await pbx(anon, ["push", "--json"]),
      "push after claim",
    );
    check(j3.pushed[0]?.version === 3 && j3.pushed[0]?.anonymous === false, `push after claim: ${JSON.stringify(j3)}`);
    ok(await pbx(anon, ["logout"]), "logout of the anon sandbox");
    return slugAnon;
  });

  await step("11", "rm → raw 404 → restore → raw 200", ["3"], async () => {
    const noYes = await pbx(sb, ["rm", slugB]);
    eq(noYes.code, 2, "rm without --yes outside a tty");
    const j = okJson<{ deleted: boolean; purgeAfter: string; unmapped: string | null }>(
      await pbx(sb, ["rm", slugB, "--yes", "--json"]),
      "pbx rm --yes",
    );
    check(j.deleted, "deleted");
    DeleteScriptResponseSchema.shape.purgeAfter.parse(j.purgeAfter);
    eq(j.unmapped, FILE_B, "unmapped file");
    const raw = await http(`/raw/${slugB}`);
    eq(raw.status, 404, "raw after rm");
    check(raw.text.startsWith("error("), "raw 404 body is lua");
    eq((await http(`/api/v1/scripts/${slugB}`, { key: apiKey })).status, 404, "api GET after rm");
    const r = await http(`/api/v1/scripts/${slugB}/restore`, { method: "POST", key: apiKey });
    eq(r.status, 200, `restore status (${r.text})`);
    UpdateScriptResponseSchema.parse(r.json);
    const back = await http(`/raw/${slugB}`);
    eq(back.status, 200, "raw after restore");
    check(back.text.includes("-- watch 2"), `raw body after restore: ${back.text}`);
    return "restored via POST /restore";
  });

  await step("12", "logout → key revoked server-side (401)", ["1"], async () => {
    const before = await http("/api/v1/me", { key: apiKey });
    eq(before.status, 200, "key works before logout");
    const j = okJson<{ loggedOut: boolean; revoked: boolean }>(await pbx(sb, ["logout", "--json"]), "pbx logout");
    check(j.loggedOut && j.revoked, `logout: ${JSON.stringify(j)}`);
    check(!existsSync(join(sb.configDir, "config.json")), "config.json removed");
    const after = await http("/api/v1/me", { key: apiKey });
    eq(after.status, 401, "old key after logout");
    eq(ApiErrorSchema.parse(after.json).error.code, "unauthorized", "error code");
    const who = await pbx(sb, ["whoami"]);
    eq(who.code, 1, "whoami after logout");
    check(/not logged in/.test(who.stderr), `whoami after logout: ${who.stderr}`);
    return undefined;
  });

  await step("13", "errors: server down, bad slug, NO_COLOR", ["3"], async () => {
    const down = await pbx(sb, ["pull", slugA, "--api", "http://localhost:1"]);
    eq(down.code, 1, "server down exit code");
    // bun connects and gets refused; node's fetch blocks port 1 as a WHATWG "bad port" up front
    check(
      /can't reach http:\/\/localhost:1 \((connection refused|port 1 is blocked by fetch)\)/.test(down.stderr),
      `server down: ${down.stderr}`,
    );
    const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = free.port;
    free.stop(true);
    const refused = await pbx(sb, ["pull", slugA, "--api", `http://127.0.0.1:${port}`]);
    eq(refused.code, 1, "refused port exit code");
    check(
      refused.stderr.includes(`can't reach http://127.0.0.1:${port} (connection refused)`),
      `refused: ${refused.stderr}`,
    );
    check(!/\n\s+at /.test(down.stderr), "no stack trace");
    const downJson = await pbx(sb, ["pull", slugA, "--api", "http://localhost:1", "--json"]);
    eq(downJson.code, 1, "server down --json exit code");
    eq((JSON.parse(downJson.stdout) as { error: { code: string } }).error.code, "network", "--json error code");

    const nf = await pbx(sb, ["log", "zzzzzzzzzz"]);
    eq(nf.code, 1, "unknown slug exit code");
    check(/script zzzzzzzzzz not found/.test(nf.stderr), `unknown slug: ${nf.stderr}`);
    const bad = await pbx(sb, ["log", "Not_A-Slug!"]);
    eq(bad.code, 2, "malformed slug exit code");

    const forced = await pbx(sb, ["log", slugA], { env: { FORCE_COLOR: "1" } });
    check(hasAnsi(forced.stdout), "FORCE_COLOR=1 should color (sanity)");
    for (const [name, env] of [
      ["NO_COLOR=1", { NO_COLOR: "1" }],
      ["NO_COLOR=1 FORCE_COLOR=1", { NO_COLOR: "1", FORCE_COLOR: "1" }],
    ] as const) {
      for (const args of [
        ["log", slugA],
        ["diff", slugA, "--from", "1", "--to", "2"],
        ["pull", "zzzzzzzzzz"],
      ]) {
        const r = await pbx(sb, args, { env });
        check(!hasAnsi(r.stdout) && !hasAnsi(r.stderr), `${name} pbx ${args.join(" ")} printed ANSI codes`);
      }
    }
    return undefined;
  });

  await step("14", "startup: node dist/pbx.js --help", [], async () => {
    if (!existsSync(join(PKG_ROOT, "dist/pbx.js"))) return "skipped (no dist build)";
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      const p = Bun.spawnSync(["node", join(PKG_ROOT, "dist/pbx.js"), "--help"], { stdout: "pipe" });
      times.push(performance.now() - t);
      check(p.exitCode === 0, "--help exit code");
    }
    times.sort((a, b) => a - b);
    const median = times[5] as number;
    check(median < 250, `median startup ${Math.round(median)}ms is over 250ms`);
    return `median ${Math.round(median)}ms, min ${Math.round(times[0] as number)}ms`;
  });

  // ── cleanup ────────────────────────────────────────────────────────────────
  if (!argv.keep) {
    const key = ciKey || apiKey;
    for (const s of created.filter(Boolean)) {
      const r = await http(`/api/v1/scripts/${s}`, { method: "DELETE", key });
      if (r.status !== 200 && r.status !== 404) console.log(`cleanup: DELETE ${s} → ${r.status}`);
    }
    if (ciKey) {
      const list = await http("/api/auth/api-key/list", { jar });
      const keys = (list.json as { apiKeys?: { id: string }[] } | { id: string }[]) ?? [];
      const arr = Array.isArray(keys) ? keys : (keys.apiKeys ?? []);
      for (const k of arr)
        await http("/api/auth/api-key/delete", { method: "POST", body: JSON.stringify({ keyId: k.id }), jar });
    }
    for (const d of sandboxes) rmSync(d, { recursive: true, force: true });
  }

  // ── table ──────────────────────────────────────────────────────────────────
  const failed = rows.filter((r) => r.status !== "pass");
  console.log(`\n| # | step | result | ms | checks |\n|---|---|---|---|---|`);
  for (const r of rows)
    console.log(`| ${r.id} | ${r.name} | ${r.status.toUpperCase()} | ${Math.round(r.ms)} | ${r.checks} |`);
  console.log(
    `\n${rows.length - failed.length}/${rows.length} passed, ${checks} checks${failed.length ? ` · FAILED: ${failed.map((r) => r.id).join(", ")}` : ""}`,
  );
  process.exit(failed.length ? 1 : 0);
}

await main();
