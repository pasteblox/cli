/**
 * End-to-end: the real CLI as a subprocess against the contract mock.
 * Runs against `bun src/index.ts` by default, or `node dist/pbx.js` with PBX_TEST_RUNNER=node.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupSandboxes, command, parseJson, pbx, RUNNER, type Sandbox, sandbox } from "./helpers";
import { type MockServer, startMockServer } from "./mock-server";

const DOOR_V1 = `local door = script.Parent\nlocal open = false\n\ndoor.Touched:Connect(function()\n  open = not open\nend)\n`;
const DOOR_V2 = `local door = script.Parent\nlocal open = false\nlocal debounce = false\n\ndoor.Touched:Connect(function()\n  if debounce then return end\n  debounce = true\n  open = not open\n  task.wait(0.5)\n  debounce = false\nend)\n`;
const HUB = `print("hub loaded")\n`;

let mock: MockServer;
beforeAll(() => {
  mock = startMockServer({ pendingPolls: 2 });
});
afterAll(() => {
  mock.stop();
  cleanupSandboxes();
  expect(mock.contractErrors).toEqual([]);
});

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe(`full flow (${RUNNER})`, () => {
  let sb: Sandbox;
  let door = "";
  let hub = "";

  beforeAll(() => {
    sb = sandbox(mock.url);
    mkdirSync(join(sb.project, "src"), { recursive: true });
    mkdirSync(join(sb.project, "node_modules/dep"), { recursive: true });
    writeFileSync(join(sb.project, "src/door.luau"), DOOR_V1);
    writeFileSync(join(sb.project, "src/hub.lua"), HUB);
    writeFileSync(join(sb.project, "node_modules/dep/skip.lua"), "return 1\n");
  });

  test("login runs the device flow and stores a 0600 key", async () => {
    const before = mock.requests.length;
    const r = await pbx(sb, ["login", "--no-browser"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("logged in as @jan");
    expect(r.stdout).toMatch(/[0-9A-F] [0-9A-F] [0-9A-F] [0-9A-F] - /); // the big spaced code
    const polls = mock.requests.slice(before).filter((q) => q.path === "/api/auth/device/token");
    expect(polls.length).toBe(3); // 2 pending + approved
    const exchange = mock.requests.slice(before).find((q) => q.path === "/api/v1/cli/exchange");
    expect(exchange?.bearer).toBeTruthy();
    expect((exchange?.body as { platform: string }).platform).toBe(`${process.platform}-${process.arch}`);
    const cfgPath = join(sb.home, ".config/pasteblox/config.json");
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    const cfg = readJson(cfgPath);
    expect(cfg.hosts[mock.url].apiKey).toStartWith("pbx_");
    expect(existsSync(sb.openedFile)).toBe(false); // --no-browser
  });

  test("login again is a no-op", async () => {
    const r = await pbx(sb, ["login"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already logged in");
  });

  test("whoami", async () => {
    const r = await pbx(sb, ["whoami", "--json"]);
    expect(r.code).toBe(0);
    const j = parseJson(r);
    expect(j).toMatchObject({ user: { handle: "jan" }, auth: { method: "api_key" }, source: "config" });
  });

  test("init --yes maps detected files, skipping node_modules", async () => {
    const r = await pbx(sb, ["init", "--yes"]);
    expect(r.code).toBe(0);
    const pj = readJson(join(sb.project, "pasteblox.json"));
    expect(pj.$schema).toBe("https://pasteblox.com/schema/pasteblox.json");
    expect(pj.scripts).toEqual([
      { file: "src/door.luau", visibility: "unlisted", title: "door" },
      { file: "src/hub.lua", visibility: "unlisted", title: "hub" },
    ]);
  });

  test("init outside a TTY without --yes/--file is a usage error", async () => {
    const r = await pbx(sb, ["init"], { cwd: join(sb.project, "src") });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs --file or --yes");
  });

  test("push (no args) creates every mapped script and writes slugs back", async () => {
    const r = await pbx(sb, ["push"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const pj = readJson(join(sb.project, "pasteblox.json"));
    door = pj.scripts[0].slug;
    hub = pj.scripts[1].slug;
    expect(door).toMatch(/^[23456789a-hjkmnp-z]{10}$/);
    expect(hub).toMatch(/^[23456789a-hjkmnp-z]{10}$/);
    expect(mock.scripts.get(hub)?.language).toBe("lua");
    expect(r.stdout).toContain(`loadstring(game:HttpGet("${mock.url}/raw/${door}"))()`);
    expect(r.stdout).toContain(`${mock.url}/s/${door}`);
    const state = readJson(join(sb.project, ".pasteblox/state.json"));
    expect(state.files["src/door.luau"]).toMatchObject({ slug: door, version: 1 });
    expect(readFileSync(join(sb.project, ".pasteblox/.gitignore"), "utf8")).toContain("*");
  });

  test("push with nothing changed says so", async () => {
    const r = await pbx(sb, ["push"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  test("push one file creates a new version with a message", async () => {
    writeFileSync(join(sb.project, "src/door.luau"), DOOR_V2);
    const r = await pbx(sb, ["push", "src/door.luau", "-m", "fix debounce", "--json"]);
    expect(r.code).toBe(0);
    const j = parseJson<{ pushed: { slug: string; version: number; created: boolean; urls: { raw: string } }[] }>(r);
    expect(j.pushed[0]).toMatchObject({
      slug: door,
      version: 2,
      created: false,
      urls: { raw: `${mock.url}/raw/${door}` },
    });
    const req = mock.requests.findLast((q) => q.path === `/api/v1/scripts/${door}/versions` && q.method === "POST");
    expect(req?.body).toMatchObject({ message: "fix debounce", baseVersion: 1 });
  });

  test("pull writes the latest version, and pinned versions on request", async () => {
    let r = await pbx(sb, ["pull", door, "-o", "copy.luau"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(sb.project, "copy.luau"), "utf8")).toBe(DOOR_V2);
    r = await pbx(sb, ["pull", `${door}@1`, "-o", "v1.luau", "--json"]);
    expect(r.code).toBe(0);
    expect(parseJson(r)).toMatchObject({ slug: door, version: 1, latestVersion: 2, written: true });
    expect(readFileSync(join(sb.project, "v1.luau"), "utf8")).toBe(DOOR_V1);
  });

  test("pull refuses to clobber unpushed local changes without --force", async () => {
    writeFileSync(join(sb.project, "src/door.luau"), `${DOOR_V2}-- wip\n`);
    let r = await pbx(sb, ["pull", door]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("src/door.luau has local changes that aren't pushed");
    r = await pbx(sb, ["pull", door, "--force"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(sb.project, "src/door.luau"), "utf8")).toBe(DOOR_V2);
  });

  test("log lists versions newest first", async () => {
    const r = await pbx(sb, ["log", door]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^v2 .* fix debounce/);
    expect(lines[1]).toMatch(/^v1 /);
    const j = parseJson<{ versions: { n: number }[] }>(await pbx(sb, ["log", "src/door.luau", "--json"]));
    expect(j.versions.map((v) => v.n)).toEqual([2, 1]);
  });

  test("diff: local file vs latest, and between versions", async () => {
    writeFileSync(join(sb.project, "src/door.luau"), DOOR_V2.replace("task.wait(0.5)", "task.wait(1)"));
    let r = await pbx(sb, ["diff", door]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`--- a/${door}@2`);
    expect(r.stdout).toContain("+++ b/src/door.luau");
    expect(r.stdout).toContain("-  task.wait(0.5)");
    expect(r.stdout).toContain("+  task.wait(1)");
    expect(r.stdout).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    r = await pbx(sb, ["diff", door, "--from", "1", "--to", "2", "--json"]);
    const j = parseJson<{ changed: boolean; added: number; removed: number; patch: string }>(r);
    expect(j.changed).toBe(true);
    expect(j.added).toBeGreaterThan(0);
    expect(j.patch).toContain("+local debounce = false");
    writeFileSync(join(sb.project, "src/door.luau"), DOOR_V2);
    r = await pbx(sb, ["diff", "src/door.luau"]);
    expect(r.stdout).toContain("no changes");
  });

  test("ls shows a table, --json returns summaries", async () => {
    let r = await pbx(sb, ["ls"]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toMatch(/^title\s+slug\s+visibility\s+ver\s+views\s+updated$/);
    expect(r.stdout).toContain(door);
    r = await pbx(sb, ["ls", "--json"]);
    const j = parseJson<{ scripts: { slug: string; latestVersion: number }[] }>(r);
    expect(j.scripts.map((s) => s.slug).sort()).toEqual([door, hub].sort());
  });

  test("loadstring prints, copies, and supports --json", async () => {
    let r = await pbx(sb, ["loadstring", door]);
    expect(r.code).toBe(0);
    const expected = `loadstring(game:HttpGet("${mock.url}/raw/${door}"))()`;
    expect(r.stdout.trim()).toBe(expected);
    expect(r.stderr).toContain("copied to clipboard");
    expect(readFileSync(sb.clipboardFile, "utf8")).toBe(expected);
    r = await pbx(sb, ["loadstring", door, "--version", "2", "--json", "--no-copy"]);
    expect(parseJson<unknown>(r)).toEqual({
      slug: door,
      version: 2,
      url: `${mock.url}/raw/${door}@2`,
      loadstring: `loadstring(game:HttpGet("${mock.url}/raw/${door}@2"))()`,
      copied: false,
    });
  });

  test("open launches the browser with the page url", async () => {
    const r = await pbx(sb, ["open", door]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`${mock.url}/s/${door}`);
    // the opener is detached: give the fake `open` a moment to write
    for (let i = 0; i < 20 && !existsSync(sb.openedFile); i++) await Bun.sleep(50);
    expect(readFileSync(sb.openedFile, "utf8").trim()).toBe(`${mock.url}/s/${door}`);
  });

  test("rm needs --yes outside a TTY, then deletes and unmaps", async () => {
    let r = await pbx(sb, ["rm", hub]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`pbx rm ${hub} --yes`);
    r = await pbx(sb, ["rm", hub, "--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(parseJson(r)).toMatchObject({ slug: hub, deleted: true, unmapped: "src/hub.lua" });
    const pj = readJson(join(sb.project, "pasteblox.json"));
    expect(pj.scripts.map((s: { file: string }) => s.file)).toEqual(["src/door.luau"]);
    r = await pbx(sb, ["pull", hub, "-o", "gone.lua"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`script ${hub} not found`);
  });

  test("version conflict when the remote moved on", async () => {
    // someone pushes from elsewhere
    const s = mock.scripts.get(door);
    if (!s) throw new Error("missing script");
    const other = `${DOOR_V2}-- from the web\n`;
    s.versions.push({
      ...(s.versions[1] as (typeof s.versions)[number]),
      n: 3,
      content: other,
      sha256: "f".repeat(64),
    });
    writeFileSync(join(sb.project, "src/door.luau"), `${DOOR_V2}-- local\n`);
    let r = await pbx(sb, ["push", "src/door.luau"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("remote moved on");
    expect(r.stderr).toContain("v3");
    r = await pbx(sb, ["push", "src/door.luau", "--force"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("v4");
  });

  test("rate limits are friendly", async () => {
    mock.rateLimit(1, 7);
    writeFileSync(join(sb.project, "src/door.luau"), `${DOOR_V2}-- rl\n`);
    const r = await pbx(sb, ["push", "src/door.luau", "--json"]);
    expect(r.code).toBe(1);
    expect(parseJson(r)).toMatchObject({ error: { code: "rate_limited", retryAfter: 7 } });
  });

  test("watch pushes on save and exits cleanly on ctrl-c", async () => {
    const proc = Bun.spawn(command(["watch"]), { cwd: sb.project, env: sb.env, stdout: "pipe", stderr: "pipe" });
    let out = "";
    let err = "";
    const pump = async (stream: ReadableStream<Uint8Array>, onText: (t: string) => void) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) onText(dec.decode(chunk));
    };
    const pumps = Promise.all([pump(proc.stdout, (t) => (out += t)), pump(proc.stderr, (t) => (err += t))]);
    const waitFor = async (needle: string, ms = 8000, onTick?: () => void) => {
      const deadline = Date.now() + ms;
      while (!out.includes(needle)) {
        if (Date.now() > deadline)
          throw new Error(`timed out waiting for "${needle}"\nstdout:\n${out}\nstderr:\n${err}`);
        onTick?.();
        await Bun.sleep(100);
      }
    };
    try {
      await waitFor("watching");
      const before = mock.scripts.get(door)?.versions.length ?? 0;
      // fsevents can take a moment to arm: keep "saving" until the push shows up
      let saves = 0;
      await waitFor("✓ door.luau → v", 8000, () => {
        if (saves++ % 10 === 0) writeFileSync(join(sb.project, "src/door.luau"), `${DOOR_V2}-- saved ${saves}\n`);
      });
      expect(out).toMatch(/✓ door\.luau → v\d+ · [\d.]+k?b · \d+ms/);
      expect(mock.scripts.get(door)?.versions.length).toBeGreaterThan(before);
      expect(mock.scripts.get(door)?.versions.at(-1)?.message).toMatch(/^watch: \d\d:\d\d:\d\d$/);
      expect(err).toBe("");
    } finally {
      proc.kill("SIGINT");
    }
    expect(await proc.exited).toBe(0);
    await pumps;
    expect(out).toContain("stopped watching");
  }, 15000);

  test("logout revokes the key and forgets it", async () => {
    const keysBefore = mock.keys.size;
    const r = await pbx(sb, ["logout"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("logged out @jan");
    expect(r.stdout).toContain("revoked");
    expect(mock.keys.size).toBe(keysBefore - 1);
    expect(existsSync(join(sb.home, ".config/pasteblox/config.json"))).toBe(false);
    const after = await pbx(sb, ["whoami"]);
    expect(after.code).toBe(1);
  });
});

describe(`anonymous push + claim on login (${RUNNER})`, () => {
  test("anonymous scripts get a claim token, can be updated, and are claimed at login", async () => {
    const sb = sandbox(mock.url);
    writeFileSync(join(sb.project, "anon.luau"), `print("hi")\n`);
    let r = await pbx(sb, ["push", "anon.luau", "--public"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("anonymous scripts are unlisted");

    r = await pbx(sb, ["push", "anon.luau"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("anonymous script");
    const slug = readJson(join(sb.project, "pasteblox.json")).scripts[0].slug as string;
    const claims = readJson(join(sb.home, ".config/pasteblox/claims.json"));
    expect(claims.hosts[mock.url][0].slug).toBe(slug);
    expect(statSync(join(sb.home, ".config/pasteblox/claims.json")).mode & 0o777).toBe(0o600);

    writeFileSync(join(sb.project, "anon.luau"), `print("hi again")\n`);
    r = await pbx(sb, ["push"]);
    expect(r.code).toBe(0);
    const pushReq = mock.requests.findLast((q) => q.path === `/api/v1/scripts/${slug}/versions`);
    expect(pushReq?.claimToken).toBeTruthy();
    expect(pushReq?.apiKey).toBeNull();

    r = await pbx(sb, ["login", "--no-browser"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("claimed 1 anonymous script");
    expect(mock.scripts.get(slug)?.ownerId).toBe("u_jan");
    expect(existsSync(join(sb.home, ".config/pasteblox/claims.json"))).toBe(false);
  });
});

describe(`changelogs: push --notes, log, note (${RUNNER})`, () => {
  let sb: Sandbox;
  let a = "";
  let b = "";
  type LogJson = { versions: { n: number; message: string; notes: string }[] };
  const versionsPost = (slug: string) =>
    mock.requests.findLast((q) => q.path === `/api/v1/scripts/${slug}/versions` && q.method === "POST");

  beforeAll(() => {
    mock.addKey("pbx_notes_key", "notes");
    sb = sandbox(mock.url, { PASTEBLOX_TOKEN: "pbx_notes_key" });
    writeFileSync(join(sb.project, "a.luau"), `print("a1")\n`);
    writeFileSync(join(sb.project, "b.luau"), `print("b1")\n`);
  });

  test("push: repeated --notes become lines, sent on create", async () => {
    let r = await pbx(sb, [
      "push",
      "a.luau",
      "-m",
      "first cut",
      "--notes",
      "- added: doors",
      "--notes",
      "- fixed: lag",
    ]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    a = readJson(join(sb.project, "pasteblox.json")).scripts[0].slug;
    const create = mock.requests.findLast((q) => q.path === "/api/v1/scripts" && q.method === "POST");
    expect(create?.body).toMatchObject({ message: "first cut", notes: "- added: doors\n- fixed: lag" });
    expect(mock.scripts.get(a)?.versions[0]?.notes).toBe("- added: doors\n- fixed: lag");

    r = await pbx(sb, ["push", "b.luau"]);
    expect(r.code).toBe(0);
    b = readJson(join(sb.project, "pasteblox.json")).scripts[1].slug;
    expect((mock.requests.at(-1)?.body as Record<string, unknown>).notes).toBeUndefined();
  });

  test("push: --notes-file - reads stdin, and every changed mapped file gets the same notes", async () => {
    writeFileSync(join(sb.project, "a.luau"), `print("a2")\n`);
    writeFileSync(join(sb.project, "b.luau"), `print("b2")\n`);
    const r = await pbx(sb, ["push", "-m", "v2", "--notes-file", "-"], {
      stdin: "## round two\r\n- changed: both files\r\n",
    });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    for (const slug of [a, b]) {
      expect(versionsPost(slug)?.body).toMatchObject({ message: "v2", notes: "## round two\n- changed: both files" });
      expect(mock.scripts.get(slug)?.versions[1]?.notes).toBe("## round two\n- changed: both files");
    }
  });

  test("push: --notes-file from a path; --notes with --notes-file is a usage error", async () => {
    writeFileSync(join(sb.project, "CHANGELOG.md"), "- removed: the old door\n");
    writeFileSync(join(sb.project, "a.luau"), `print("a3")\n`);
    let r = await pbx(sb, ["push", "a.luau", "--notes", "x", "--notes-file", "CHANGELOG.md"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("pick one of --notes or --notes-file");
    r = await pbx(sb, ["push", "a.luau", "--notes-file", "CHANGELOG.md"]);
    expect(r.code).toBe(0);
    expect(versionsPost(a)?.body).toMatchObject({ notes: "- removed: the old door" });
    expect((versionsPost(a)?.body as Record<string, unknown>).message).toBeUndefined();
  });

  test("push: an unchanged file with notes points at pbx note", async () => {
    const r = await pbx(sb, ["push", "a.luau", "--notes", "- fixed: typo"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`pbx note ${a} 3`);
  });

  test("log: notes under each summary, --short hides them, --json carries them", async () => {
    let r = await pbx(sb, ["log", "a.luau"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    const v1 = lines.findIndex((l) => /^v1 .* first cut/.test(l));
    expect(lines[v1 + 1]).toMatch(/^ {6,}• added doors$/);
    expect(lines[v1 + 2]).toMatch(/^ {6,}• fixed lag$/);
    // notes start under the summary column
    expect(lines[v1 + 1]?.indexOf("•")).toBe(lines[v1]?.indexOf("first cut"));
    expect(r.stdout).toContain("round two");
    expect(r.stdout).toContain("• removed the old door");
    expect(lines.at(-2)).not.toBe(""); // no blank line after the last entry

    r = await pbx(sb, ["log", "a.luau", "--short"]);
    expect(r.stdout.trim().split("\n")).toHaveLength(3);
    expect(r.stdout).not.toContain("added");

    const j = parseJson<LogJson>(await pbx(sb, ["log", a, "--json"]));
    expect(j.versions.map((v) => v.notes)).toEqual([
      "- removed: the old door",
      "## round two\n- changed: both files",
      "- added: doors\n- fixed: lag",
    ]);
  });

  test("note: rewrites a past version's summary and changelog", async () => {
    let r = await pbx(sb, ["note", a, "1", "-m", "the first cut", "--notes", "- added: doors, finally"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("v1");
    expect(r.stdout).toContain("the first cut");
    expect(r.stdout).toContain("• added doors, finally");
    const patch = mock.requests.at(-1);
    expect(patch).toMatchObject({
      method: "PATCH",
      path: `/api/v1/scripts/${a}/versions/1`,
      body: { message: "the first cut", notes: "- added: doors, finally" },
    });
    expect(patch?.apiKey).toBe("pbx_notes_key");

    // slug@n, notes only: the message stays
    r = await pbx(sb, ["note", `${b}@2`, "--notes-file", "CHANGELOG.md", "--json"]);
    expect(r.code).toBe(0);
    expect(parseJson(r)).toMatchObject({
      slug: b,
      version: { n: 2, message: "v2", notes: "- removed: the old door" },
    });
    expect(mock.requests.at(-1)?.body).toEqual({ notes: "- removed: the old door" });
  });

  test('note: no version means the latest; --notes "" clears', async () => {
    const r = await pbx(sb, ["note", "a.luau", "--notes", ""]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no changelog");
    expect(mock.requests.at(-1)).toMatchObject({ path: `/api/v1/scripts/${a}/versions/3`, body: { notes: "" } });
    expect(mock.scripts.get(a)?.versions[2]?.notes).toBe("");
  });

  test("note: usage and api errors", async () => {
    let r = await pbx(sb, ["note", a, "2"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("nothing to change");
    r = await pbx(sb, ["note", `${a}@1`, "2", "-m", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("name different versions");
    r = await pbx(sb, ["note", a, "9", "-m", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("version 9 does not exist");
    const other = sandbox(mock.url);
    r = await pbx(other, ["note", a, "1", "-m", "mine now"]);
    expect(r.code).toBe(1);
    expect(mock.scripts.get(a)?.versions[0]?.message).toBe("the first cut");
  });

  test("help covers the new flags and command", async () => {
    expect((await pbx(sb, ["help", "push"])).stdout).toContain("--notes-file <path>");
    expect((await pbx(sb, ["log", "--help"])).stdout).toContain("--short");
    const help = await pbx(sb, ["help", "note"]);
    expect(help.stdout).toContain("usage\n  pbx note <slug> [n] [flags]");
    expect((await pbx(sb, ["--help"])).stdout).toMatch(/note\s+rewrite a version's summary or changelog/);
  });
});

describe(`auth, errors and output modes (${RUNNER})`, () => {
  test("PASTEBLOX_TOKEN authenticates without a config file", async () => {
    mock.addKey("pbx_ci_token_123", "github actions");
    const sb = sandbox(mock.url, { PASTEBLOX_TOKEN: "pbx_ci_token_123" });
    let r = await pbx(sb, ["whoami", "--json"]);
    expect(r.code).toBe(0);
    expect(parseJson(r)).toMatchObject({ source: "PASTEBLOX_TOKEN", auth: { keyName: "github actions" } });
    writeFileSync(join(sb.project, "ci.luau"), `print("ci")\n`);
    r = await pbx(sb, ["push", "ci.luau", "--private"]);
    expect(r.code).toBe(0);
    const req = mock.requests.findLast((q) => q.path === "/api/v1/scripts" && q.method === "POST");
    expect(req?.apiKey).toBe("pbx_ci_token_123");
    expect(req?.body).toMatchObject({ visibility: "private", title: "ci", language: "luau" });
  });

  test("a rejected PASTEBLOX_TOKEN says which token", async () => {
    const sb = sandbox(mock.url, { PASTEBLOX_TOKEN: "pbx_nope" });
    const r = await pbx(sb, ["ls"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("PASTEBLOX_TOKEN was rejected");
  });

  test("not logged in: exact friendly message, exit 1", async () => {
    const sb = sandbox(mock.url);
    const r = await pbx(sb, ["ls"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("✗ not logged in — run pbx login (or set PASTEBLOX_TOKEN for CI)\n");
  });

  test("streaming commands (watch/login --json) print errors as one NDJSON line", async () => {
    const sb = sandbox(mock.url);
    const r = await pbx(sb, ["watch", "--json"]);
    expect(r.code).toBe(2);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: "usage" } });
  });

  test("--json errors are machine-readable on stdout", async () => {
    const sb = sandbox(mock.url);
    const r = await pbx(sb, ["ls", "--json"]);
    expect(r.code).toBe(1);
    expect(parseJson<unknown>(r)).toEqual({
      error: { code: "not_logged_in", message: "not logged in", hint: "run pbx login (or set PASTEBLOX_TOKEN for CI)" },
    });
  });

  test("network errors point at --api", async () => {
    const sb = sandbox("http://127.0.0.1:9");
    const r = await pbx(sb, ["pull", "k3m9x2p7qa"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("can't reach http://127.0.0.1:9");
    expect(r.stderr).toContain("--api");
  });

  test("usage errors exit 2 with suggestions", async () => {
    const sb = sandbox(mock.url);
    let r = await pbx(sb, ["pusj"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command "pusj" (did you mean push?)');
    r = await pbx(sb, ["push", "--mesage", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("did you mean --message?");
    r = await pbx(sb, ["pull"]);
    expect(r.code).toBe(2);
    r = await pbx(sb, ["pull", "not-a-slug!"]);
    expect(r.code).toBe(2);
  });

  test("login: denied in the browser", async () => {
    const denied = startMockServer({ deviceOutcome: "deny", pendingPolls: 1 });
    try {
      const sb = sandbox(denied.url);
      const r = await pbx(sb, ["login", "--no-browser"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("login was denied in the browser");
      expect(existsSync(join(sb.home, ".config/pasteblox/config.json"))).toBe(false);
    } finally {
      denied.stop();
    }
  });

  test("login --json streams the code then the result", async () => {
    const sb = sandbox(mock.url);
    const r = await pbx(sb, ["login", "--no-browser", "--json"]);
    expect(r.code).toBe(0);
    const lines = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      event: "device_code",
      verificationUri: expect.stringContaining("/device?user_code="),
    });
    expect(lines[1]).toMatchObject({ event: "logged_in", user: { handle: "jan" } });
  });

  test("NO_COLOR beats FORCE_COLOR; FORCE_COLOR colors piped output", async () => {
    const sb = sandbox(mock.url);
    const colored = await pbx(sb, ["--help"], { env: { FORCE_COLOR: "1" } });
    expect(colored.stdout).toContain("\x1b[");
    const plain = await pbx(sb, ["--help"], { env: { FORCE_COLOR: "1", NO_COLOR: "1" } });
    expect(plain.stdout).not.toContain("\x1b[");
    const piped = await pbx(sb, ["--help"]);
    expect(piped.stdout).not.toContain("\x1b[");
    const flag = await pbx(sb, ["--help", "--no-color"], { env: { FORCE_COLOR: "3" } });
    expect(flag.stdout).not.toContain("\x1b[");
  });

  test("--version, help <cmd>, --help", async () => {
    const sb = sandbox(mock.url);
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    expect((await pbx(sb, ["--version"])).stdout.trim()).toBe(pkg.version);
    const help = await pbx(sb, ["help", "push"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("usage\n  pbx push [file] [flags]");
    expect(help.stdout).toContain("--message <text>");
    expect((await pbx(sb, ["diff", "--help"])).stdout).toContain("--from <n>");
  });
});
