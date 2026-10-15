import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api, networkError, type RawResponse } from "../src/lib/api";
import { parseArgs } from "../src/lib/args";
import { detectColorLevel, makePalette, stripAnsi } from "../src/lib/color";
import { resolveRef } from "../src/lib/context";
import { formatUserCode, pollForToken } from "../src/lib/device";
import { diffKeys, unifiedDiff } from "../src/lib/diff";
import { findProject } from "../src/lib/project";
import { ago, formatBytes } from "../src/lib/ui";

describe("args", () => {
  const specs = {
    message: { type: "string" as const, short: "m", desc: "" },
    yes: { type: "boolean" as const, short: "y", desc: "" },
    file: { type: "string" as const, short: "f", multiple: true, desc: "" },
    "no-browser": { type: "boolean" as const, desc: "" },
    json: { type: "boolean" as const, desc: "" },
  };
  test("long, short, inline, repeated, negated, terminator", () => {
    const r = parseArgs(
      ["push", "-m", "hi there", "--json", "-f", "a.luau", "--file=b.luau", "-y", "--no-browser", "--", "--literal"],
      specs,
      "x",
    );
    expect(r.positionals).toEqual(["push", "--literal"]);
    expect(r.flags).toEqual({
      message: "hi there",
      json: true,
      file: ["a.luau", "b.luau"],
      yes: true,
      "no-browser": true,
    });
  });
  test("--no-<bool> negates; -mvalue works", () => {
    expect(parseArgs(["--no-json", "-mfix"], specs, "x").flags).toEqual({ json: false, message: "fix" });
  });
  test("unknown flags suggest the closest one", () => {
    expect(() => parseArgs(["--mesage", "x"], specs, "push")).toThrow("did you mean --message?");
  });
  test("missing values are usage errors", () => {
    expect(() => parseArgs(["-m"], specs, "push")).toThrow("-m needs a value");
    expect(() => parseArgs(["--message", "--json"], specs, "push")).toThrow("--message needs a value");
  });
});

describe("diff", () => {
  test("myers finds the minimal edit", () => {
    const e = diffKeys("abcabba".split(""), "cbabac".split(""));
    expect(e.filter((x) => x.type !== "eq").length).toBe(5); // classic Myers example: D = 5
  });
  test("unified output matches diff -u", () => {
    const a = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
    const b = "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n";
    const d = unifiedDiff(a, b, { oldLabel: "a/x", newLabel: "b/x" });
    expect(d.lines.map((l) => l.text)).toEqual([
      "--- a/x",
      "+++ b/x",
      "@@ -1,6 +1,6 @@",
      " one",
      " two",
      "-three",
      "+THREE",
      " four",
      " five",
      " six",
      "@@ -8,3 +8,4 @@",
      " eight",
      " nine",
      " ten",
      "+eleven",
    ]);
    expect([d.added, d.removed]).toEqual([2, 1]);
  });
  test("no newline at end of file", () => {
    const d = unifiedDiff("a\nb", "a\nb\n", { oldLabel: "a", newLabel: "b" });
    expect(d.lines.map((l) => l.text)).toEqual([
      "--- a",
      "+++ b",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+b",
    ]);
  });
  test("identical and empty inputs", () => {
    expect(unifiedDiff("x\n", "x\n", { oldLabel: "a", newLabel: "b" }).changed).toBe(false);
    const d = unifiedDiff("", "new\n", { oldLabel: "a", newLabel: "b" });
    expect(d.lines[2]?.text).toBe("@@ -0,0 +1 @@");
  });
  test("large inputs stay fast", () => {
    const a = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 100\n", "line 100 changed\n").replace("line 15000\n", "");
    const t = performance.now();
    const d = unifiedDiff(a, b, { oldLabel: "a", newLabel: "b" });
    expect(performance.now() - t).toBeLessThan(500);
    expect([d.added, d.removed]).toEqual([1, 2]);
  });
});

describe("device polling (RFC 8628)", () => {
  const res = (status: number, json: unknown): RawResponse => ({ status, json, headers: new Headers() });
  test("pending → slow_down (+5s) → token", async () => {
    const answers = [
      res(400, { error: "authorization_pending" }),
      res(400, { error: "slow_down" }),
      res(400, { error: "authorization_pending" }),
      res(200, { access_token: "tok", token_type: "Bearer" }),
    ];
    const sleeps: number[] = [];
    let clock = 0;
    const token = await pollForToken({
      poll: async () => answers.shift() as RawResponse,
      interval: 5,
      expiresIn: 900,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      onHttpError: () => new Error("http"),
    });
    expect(token).toBe("tok");
    expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
  });
  test("expiry, denial", async () => {
    let clock = 0;
    const base = {
      interval: 5,
      expiresIn: 12,
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      onHttpError: () => new Error("http"),
    };
    await expect(
      pollForToken({ ...base, poll: async () => res(400, { error: "authorization_pending" }) }),
    ).rejects.toThrow("expired");
    clock = 0;
    await expect(pollForToken({ ...base, poll: async () => res(400, { error: "access_denied" }) })).rejects.toThrow(
      "denied",
    );
    clock = 0;
    await expect(pollForToken({ ...base, poll: async () => res(400, { error: "expired_token" }) })).rejects.toThrow(
      "expired",
    );
  });
  test("better-auth 429 backs off (X-Retry-After) and keeps polling", async () => {
    const limited: RawResponse = {
      status: 429,
      json: { message: "Too many requests. Please try again later." },
      headers: new Headers({ "x-retry-after": "30" }),
    };
    const answers = [
      res(400, { error: "authorization_pending" }),
      limited,
      res(200, { access_token: "tok", token_type: "Bearer" }),
    ];
    const sleeps: number[] = [];
    let clock = 0;
    const token = await pollForToken({
      poll: async () => answers.shift() as RawResponse,
      interval: 5,
      expiresIn: 900,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      onHttpError: () => new Error("http"),
    });
    expect(token).toBe("tok");
    // 5s, 5s → 429: interval 10s plus 20s more to honor the 30s retry-after → 10s
    expect(sleeps).toEqual([5000, 5000, 20000, 10000]);
  });
  test("a non-contract 429 maps to rate_limited, not 'is --api a pasteblox server?'", () => {
    const api = new Api("http://x", null);
    const e = api.toError(
      { status: 429, json: { message: "Too many requests." }, headers: new Headers({ "x-retry-after": "7" }) },
      { path: "/api/auth/device/code" },
    );
    expect(e.code).toBe("rate_limited");
    expect(e.message).toBe("rate limited, retry in 7s");
    expect(e.details?.retryAfter).toBe(7);
  });
  test("user codes read as ABCD-EFGH", () => {
    expect(formatUserCode("abcd2345")).toBe("ABCD-2345");
  });
});

describe("color", () => {
  test("NO_COLOR wins, FORCE_COLOR forces, non-TTY is plain", () => {
    expect(detectColorLevel({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "3" })).toBe(0);
    expect(detectColorLevel({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(1);
    expect(detectColorLevel({ isTTY: false }, { FORCE_COLOR: "3" })).toBe(3);
    expect(detectColorLevel({ isTTY: true }, { FORCE_COLOR: "0" })).toBe(0);
    expect(detectColorLevel({ isTTY: false }, {})).toBe(0);
    expect(detectColorLevel({ isTTY: true }, { TERM: "dumb" })).toBe(0);
    expect(detectColorLevel({ isTTY: true }, { COLORTERM: "truecolor" })).toBe(3);
    expect(detectColorLevel({ isTTY: true }, { TERM: "xterm" })).toBe(1);
  });
  test("brand baby blue in truecolor, bright cyan in basic", () => {
    expect(makePalette(3).accent("x")).toBe("\x1b[38;2;140;207;255mx\x1b[39m");
    expect(makePalette(1).accent("x")).toBe("\x1b[96mx\x1b[39m");
    expect(stripAnsi(makePalette(3).error("boom"))).toBe("boom");
  });
});

describe("refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pbx-ref-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "pasteblox.json"),
    JSON.stringify({ scripts: [{ file: "src/door.luau", slug: "k3m9x2p7qa" }, { file: "new.luau" }] }),
  );
  const project = findProject(dir);
  test("slug, slug@n, urls, mapped files", () => {
    expect(resolveRef("K3M9X2P7QA", "x", project).slug).toBe("k3m9x2p7qa");
    expect(resolveRef("k3m9x2p7qa@4", "x", project)).toMatchObject({ slug: "k3m9x2p7qa", version: 4 });
    expect(resolveRef("https://pasteblox.com/s/k3m9x2p7qa", "x", project).slug).toBe("k3m9x2p7qa");
    expect(resolveRef("https://pasteblox.com/raw/k3m9x2p7qa@2", "x", project).version).toBe(2);
    expect(resolveRef("https://pasteblox.com/raw/k3m9x2p7qa/v3", "x", project).version).toBe(3);
    expect(resolveRef(join(dir, "src/door.luau"), "x", project).slug).toBe("k3m9x2p7qa");
    expect(resolveRef(undefined, "x", project).slug).toBe("k3m9x2p7qa");
  });
  test("helpful failures", () => {
    expect(() => resolveRef(join(dir, "new.luau"), "x", project)).toThrow("isn't pushed yet");
    expect(() => resolveRef("nope", "x", project)).toThrow("isn't a slug or a mapped file");
    expect(() => resolveRef("https://example.com/foo", "x", project)).toThrow(
      "doesn't look like a pasteblox script url",
    );
  });
});

describe("formatting", () => {
  test("bytes and ages", () => {
    expect(formatBytes(512)).toBe("512b");
    expect(formatBytes(1946)).toBe("1.9kb");
    expect(formatBytes(2048)).toBe("2kb");
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(ago("2026-10-15T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-10-15T10:00:00Z", now)).toBe("2h ago");
    expect(ago("2026-10-12T12:00:00Z", now)).toBe("3d ago");
  });
});

describe("network errors", () => {
  const fetchFailed = (cause: Record<string, unknown>) => Object.assign(new TypeError("fetch failed"), { cause });

  test("node: connection refused (AggregateError with code)", () => {
    const e = networkError("http://localhost:59999", fetchFailed({ name: "AggregateError", code: "ECONNREFUSED" }));
    expect(e.message).toBe("can't reach http://localhost:59999 (connection refused)");
    expect(e.code).toBe("network");
  });

  test("bun: ConnectionRefused on the error itself", () => {
    const e = networkError("http://localhost:1", Object.assign(new Error("refused"), { code: "ConnectionRefused" }));
    expect(e.message).toBe("can't reach http://localhost:1 (connection refused)");
  });

  test("node: WHATWG bad port names the port instead of 'network error'", () => {
    const e = networkError("http://localhost:1", fetchFailed({ message: "bad port" }));
    expect(e.message).toBe("can't reach http://localhost:1 (port 1 is blocked by fetch)");
    expect(e.hint).toContain("different port");
    expect(e.code).toBe("network");
  });
});
