/**
 * Push-time safety heuristics. Pure, synchronous, runtime-agnostic:
 * the web app runs it on create/push/fork, and `pbx push` can run it locally before uploading.
 *
 * Guarantees:
 * - Linear in the input. Every regex has a literal anchor and no nested quantifiers; the two
 *   "run length" checks (escape_run, blob_line) are hand-written single-pass scanners.
 * - Never throws, never blocks, never changes content. Output is informational only.
 */
import type { SAFETY_FLAG_CODES, SAFETY_SEVERITIES } from "./constants";

export type SafetyCode = (typeof SAFETY_FLAG_CODES)[number];
export type SafetySeverity = (typeof SAFETY_SEVERITIES)[number];

export interface SafetyFinding {
  code: SafetyCode;
  severity: SafetySeverity;
  /** 1-based line of the first match */
  line?: number;
  /** number of matches */
  count: number;
  /** remote_loader / http_exfil: distinct hosts seen (max 10) */
  hosts?: string[];
}

const SEVERITY: Record<SafetyCode, SafetySeverity> = {
  discord_webhook: "high",
  roblosecurity: "high",
  ip_logger: "high",
  http_exfil: "warn",
  remote_loader: "info",
  env_tamper: "warn",
  escape_run: "warn",
  blob_line: "warn",
  obfuscator_signature: "info",
};

const SEVERITY_RANK: Record<SafetySeverity, number> = {
  info: 0,
  warn: 1,
  high: 2,
};

/**
 * Webhook URL with an id and any token. Real tokens are 68 chars; we accept ≥ 8 so that
 * truncated/test tokens (and the seeded demo) still get flagged: a webhook id plus anything
 * token-shaped in a public paste is worth a warning.
 */
const DISCORD_WEBHOOK_RE =
  /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d{1,2}\/)?webhooks\/\d{17,20}\/[\w-]{8,100}|https?:\/\/(?:hooks\.hyra\.io|webhook\.lewisakura\.moe|webhook\.newstargeted\.com)\/api\/webhooks\/\d{17,20}\/[\w-]{8,100}/gi;

const ROBLOSECURITY_RE = /\.ROBLOSECURITY|_\|WARNING:-DO-NOT-SHARE-THIS/gi;

/** Known IP-logger / grabber domains. Kept as a list so it is easy to extend. */
export const IP_LOGGER_HOSTS = [
  "grabify.link",
  "iplogger.org",
  "iplogger.com",
  "iplogger.ru",
  "iplogger.co",
  "iplogger.info",
  "2no.co",
  "yip.su",
  "ipgrabber.ru",
  "ipgraber.ru",
  "blasze.com",
  "blasze.tk",
  "ps3cfw.com",
  "iplis.ru",
  "02ip.ru",
  "ezstat.ru",
  "lovebird.guru",
  "trulove.guru",
  "dateing.club",
  "shrekis.life",
  "headshot.monster",
  "gaming-at-my.best",
  "progaming.monster",
  "yourmy.monster",
  "imageshare.best",
  "screenshot.best",
  "gamingfun.me",
  "catsnthing.com",
  "fortnitechat.site",
  "freegiftcards.co",
  "stopify.co",
  "leancoding.co",
  "joinmy.site",
  "myprivate.pics",
  "noob.show",
  "spottyfly.com",
  "curiouscat.club",
] as const;

const IP_LOGGER_RE = new RegExp(
  `(?:^|[^a-z0-9.-])(?:${IP_LOGGER_HOSTS.map((h) => h.replace(/[.-]/g, "\\$&")).join("|")})(?![a-z0-9-])`,
  "gi",
);

/** Executor/Roblox HTTP request calls. Lowercase `request(` only; `RequestAsync` is Roblox's own API. */
const HTTP_CALL_RE = /(?:syn\.request|http_request|http\.request|fluxus\.request|\brequest)\s*\(/g;
/** `Url = "<literal>"` or `Url = <expr>` within the request table. */
const URL_FIELD_RE = /\bUrl\s*=\s*(?:(["'])([^"'\n]{0,500})\1|([A-Za-z_][\w.:[\]"']{0,80}))/;
const HTTP_CALL_WINDOW = 400;

const REMOTE_LOADER_RE = /loadstring\s*\(\s*game\s*:\s*HttpGet(?:Async)?\s*\(\s*(?:(["'])([^"'\n]{0,500})\1)?/g;

const GETFENV_RE = /\b[gs]etfenv\b/;
const LOADSTRING_RE = /\bloadstring\b/;

const OBFUSCATOR_RE =
  /MoonSec(?:V\d)?|\bLuraph\b|\bLPH_[A-Z_]{2,}|Prometheus Obfuscator|\bIronBrew\d?\b|\bPSU_[A-Za-z_]+|Obfuscated (?:with|by) PSU/g;

const ESCAPE_RUN_MIN = 200;
const BLOB_LINE_MIN = 4096;

/**
 * Scans `content` and returns one finding per triggered heuristic, highest severity first.
 * Linear time; safe to call on every push (target < 10 ms for 512 KB).
 */
export function scanScript(content: string): SafetyFinding[] {
  const lines = new LineIndex(content);
  const found: SafetyFinding[] = [];

  const simple = (code: SafetyCode, re: RegExp) => {
    re.lastIndex = 0;
    let count = 0;
    let first = -1;
    for (let m = re.exec(content); m; m = re.exec(content)) {
      if (first === -1) first = m.index;
      count++;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (count > 0)
      found.push({
        code,
        severity: SEVERITY[code],
        line: lines.lineOf(first),
        count,
      });
  };

  simple("discord_webhook", DISCORD_WEBHOOK_RE);
  simple("roblosecurity", ROBLOSECURITY_RE);
  simple("ip_logger", IP_LOGGER_RE);
  simple("obfuscator_signature", OBFUSCATOR_RE);

  // Second look at a de-obfuscated view for the high-severity URL/cookie heuristics:
  // `"https://disc" .. "ord.com/api/webhooks/…"`, `"\x2e"`/`"\46"` escapes, string.char(…).
  // No line number (offsets don't map back); count 1.
  const unhidden = deobfuscate(content);
  if (unhidden !== content) {
    const already = new Set(found.map((f) => f.code));
    for (const [code, re] of [
      ["discord_webhook", DISCORD_WEBHOOK_RE],
      ["roblosecurity", ROBLOSECURITY_RE],
      ["ip_logger", IP_LOGGER_RE],
    ] as const) {
      if (already.has(code)) continue;
      re.lastIndex = 0;
      if (re.test(unhidden)) found.push({ code, severity: SEVERITY[code], count: 1 });
      re.lastIndex = 0;
    }
  }

  // http_exfil: request(...) whose Url isn't a *.roblox.com literal.
  {
    HTTP_CALL_RE.lastIndex = 0;
    let count = 0;
    let first = -1;
    const hosts = new Set<string>();
    for (let m = HTTP_CALL_RE.exec(content); m; m = HTTP_CALL_RE.exec(content)) {
      const window = content.slice(m.index, m.index + HTTP_CALL_WINDOW);
      const url = URL_FIELD_RE.exec(window);
      if (!url) continue;
      const literal = url[2];
      if (literal !== undefined) {
        const host = hostOf(literal);
        if (host && isRobloxHost(host)) continue;
        if (host) hosts.add(host);
      }
      if (first === -1) first = m.index;
      count++;
    }
    if (count > 0)
      found.push({
        code: "http_exfil",
        severity: SEVERITY.http_exfil,
        line: lines.lineOf(first),
        count,
        ...(hosts.size ? { hosts: [...hosts].slice(0, 10) } : {}),
      });
  }

  // remote_loader: loadstring(game:HttpGet("…")) with the hosts it pulls from.
  {
    REMOTE_LOADER_RE.lastIndex = 0;
    let count = 0;
    let first = -1;
    const hosts = new Set<string>();
    for (let m = REMOTE_LOADER_RE.exec(content); m; m = REMOTE_LOADER_RE.exec(content)) {
      if (first === -1) first = m.index;
      count++;
      const host = m[2] ? hostOf(m[2]) : null;
      if (host) hosts.add(host);
    }
    if (count > 0)
      found.push({
        code: "remote_loader",
        severity: SEVERITY.remote_loader,
        line: lines.lineOf(first),
        count,
        ...(hosts.size ? { hosts: [...hosts].slice(0, 10) } : {}),
      });
  }

  // env_tamper: getfenv/setfenv AND loadstring in the same file.
  {
    const fenv = GETFENV_RE.exec(content);
    if (fenv && LOADSTRING_RE.test(content)) {
      const re = new RegExp(GETFENV_RE.source, "g");
      let count = 0;
      while (re.exec(content)) count++;
      found.push({
        code: "env_tamper",
        severity: SEVERITY.env_tamper,
        line: lines.lineOf(fenv.index),
        count,
      });
    }
  }

  // escape_run + blob_line: one pass over the characters.
  const runs = scanRuns(content);
  if (runs.escape.count > 0)
    found.push({
      code: "escape_run",
      severity: SEVERITY.escape_run,
      line: lines.lineOf(runs.escape.first),
      count: runs.escape.count,
    });
  if (runs.blob.count > 0)
    found.push({
      code: "blob_line",
      severity: SEVERITY.blob_line,
      line: lines.lineOf(runs.blob.first),
      count: runs.blob.count,
    });

  return found.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** Highest severity among findings, or null if clean. */
export function maxSeverity(findings: readonly { severity: SafetySeverity }[]): SafetySeverity | null {
  let best: SafetySeverity | null = null;
  for (const f of findings) if (best === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
  return best;
}

export function severityOf(code: SafetyCode): SafetySeverity {
  return SEVERITY[code];
}

// ── internals ────────────────────────────────────────────────────────────────

/** Lazily built newline index: offset → 1-based line via binary search. */
class LineIndex {
  private starts: number[] | null = null;
  constructor(private readonly text: string) {}
  lineOf(offset: number): number {
    if (!this.starts) {
      const starts = [0];
      for (let i = this.text.indexOf("\n"); i !== -1; i = this.text.indexOf("\n", i + 1)) starts.push(i + 1);
      this.starts = starts;
    }
    const s = this.starts;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((s[mid] ?? Number.POSITIVE_INFINITY) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

interface RunStat {
  count: number;
  first: number;
}

function isDigit(c: number) {
  return c >= 48 && c <= 57;
}
function isHex(c: number) {
  return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function isB64(c: number) {
  return isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61;
}

/**
 * Single pass:
 * - escape units: `\d{1,3}` or `\xHH` back to back; a run of ≥ 200 counts once.
 * - blob: ≥ 4096 consecutive base64/hex chars without a newline; counts once per run.
 */
function scanRuns(text: string): { escape: RunStat; blob: RunStat } {
  const escapes: RunStat = { count: 0, first: -1 };
  const blob: RunStat = { count: 0, first: -1 };
  let escUnits = 0;
  let escStart = -1;
  let escCounted = false;
  let blobLen = 0;
  let blobStart = -1;
  let blobCounted = false;

  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);

    // escape units
    if (c === 92 /* \ */ && i + 1 < n) {
      const d = text.charCodeAt(i + 1);
      let len = 0;
      if (isDigit(d)) {
        len = 2;
        if (i + 2 < n && isDigit(text.charCodeAt(i + 2))) {
          len = 3;
          if (i + 3 < n && isDigit(text.charCodeAt(i + 3))) len = 4;
        }
      } else if (
        (d === 120 || d === 88) /* x */ &&
        i + 3 < n &&
        isHex(text.charCodeAt(i + 2)) &&
        isHex(text.charCodeAt(i + 3))
      ) {
        len = 4;
      }
      if (len > 0) {
        if (escUnits === 0) {
          escStart = i;
          escCounted = false;
        }
        escUnits++;
        if (escUnits >= ESCAPE_RUN_MIN && !escCounted) {
          escCounted = true;
          escapes.count++;
          if (escapes.first === -1) escapes.first = escStart;
        }
        // escapes are not base64 chars: they break a blob run
        blobLen = 0;
        i += len;
        continue;
      }
    }
    escUnits = 0;

    // blob runs
    if (isB64(c)) {
      if (blobLen === 0) {
        blobStart = i;
        blobCounted = false;
      }
      blobLen++;
      if (blobLen >= BLOB_LINE_MIN && !blobCounted) {
        blobCounted = true;
        blob.count++;
        if (blob.first === -1) blob.first = blobStart;
      }
    } else {
      blobLen = 0;
    }
    i++;
  }
  return { escape: escapes, blob };
}

/** `"a" .. 'b'` → `"ab'` (quote style is irrelevant to the URL/cookie regexes). */
const CONCAT_SEAM_RE = /(["'])\s*\.\.\s*(["'])/g;
/** Lua escapes: `\104`, `\x68`, `\u{68}`. */
const LUA_ESCAPE_RE = /\\(\d{1,3})|\\[xX]([0-9a-fA-F]{2})|\\u\{([0-9a-fA-F]{1,6})\}/g;
/** `string.char(104, 116, 116, 112)` (bounded argument list). */
const STRING_CHAR_RE = /string\s*\.\s*char\s*\(([\d\s,]{1,8000})\)/g;

function codePointOr(n: number, fallback: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

/**
 * Cheap, linear de-obfuscation for the scanner only (never stored or served): joins string
 * concatenations and decodes escape sequences. Returns `text` unchanged when there is nothing to do.
 */
export function deobfuscate(text: string): string {
  if (!text.includes("..") && !text.includes("\\") && !/string\s*\.\s*char/.test(text)) return text;
  return text
    .replace(STRING_CHAR_RE, (m, args: string) => {
      const parts = args.split(",").map((s) => s.trim());
      if (parts.some((p) => !/^\d{1,7}$/.test(p))) return m;
      return `"${parts.map((p) => codePointOr(Number(p), "")).join("")}"`;
    })
    .replace(LUA_ESCAPE_RE, (m, dec?: string, hex?: string, uni?: string) => {
      if (dec !== undefined) return codePointOr(Number(dec), m);
      if (hex !== undefined) return codePointOr(Number.parseInt(hex, 16), m);
      return codePointOr(Number.parseInt(uni ?? "", 16), m);
    })
    .replace(CONCAT_SEAM_RE, "");
}

function hostOf(url: string): string | null {
  const m = /^\s*(?:https?:)?\/\/([^/?#:\s]+)/i.exec(url);
  return m?.[1]?.toLowerCase() ?? null;
}

function isRobloxHost(host: string): boolean {
  return host === "roblox.com" || host.endsWith(".roblox.com");
}
