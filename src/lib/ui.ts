/**
 * Output primitives: human lines on stdout, spinners/prompts/errors on stderr,
 * one JSON document on stdout in --json mode.
 */
import { c, ce, visibleWidth } from "./color";
import { CliError } from "./errors";

export const sym = {
  ok: "✓",
  err: "✗",
  warn: "!",
  dot: "·",
  arrow: "→",
};

let jsonMode = false;
/** `login`/`watch --json` stream NDJSON: errors must be one line too, not a pretty document. */
let jsonLines = false;
export function setJsonLines(v: boolean) {
  jsonLines = v;
}
export function setJsonMode(v: boolean) {
  jsonMode = v;
}
export function isJson(): boolean {
  return jsonMode;
}

export function out(line = ""): void {
  if (jsonMode) return;
  process.stdout.write(`${line}\n`);
}

export function errLine(line = ""): void {
  process.stderr.write(`${line}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** One-line JSON (for streams like `pbx watch --json`). */
export function printJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function success(msg: string): void {
  out(`${c.accent(sym.ok)} ${msg}`);
}

export function note(msg: string): void {
  out(`${c.muted(sym.dot)} ${msg}`);
}

export function warn(msg: string): void {
  if (jsonMode) return;
  errLine(`${ce.accent(sym.warn)} ${msg}`);
}

export function renderError(e: CliError): string {
  const head = `${ce.error(sym.err)} ${e.message}`;
  return e.hint ? `${head} ${ce.muted("—")} ${e.hint}` : head;
}

export function printError(e: unknown): number {
  const err =
    e instanceof CliError
      ? e
      : new CliError(e instanceof Error ? e.message : String(e), {
          code: "internal",
          hint: "that's a bug in pbx: please report it at https://pasteblox.com/cli",
        });
  if (jsonMode) {
    const body = { error: { code: err.code, message: err.message, hint: err.hint ?? null, ...err.details } };
    if (jsonLines) printJsonLine(body);
    else printJson(body);
  } else {
    errLine(renderError(err));
    if (!(e instanceof CliError) && process.env.PBX_DEBUG && e instanceof Error && e.stack) errLine(ce.muted(e.stack));
  }
  return err.exitCode;
}

// ── formatting ───────────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")}kb`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")}mb`;
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

export function clock(d = new Date()): string {
  return d.toTimeString().slice(0, 8);
}

export function padEnd(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : " ".repeat(width - w) + s;
}

export function truncate(s: string, width: number): string {
  const chars = [...s];
  if (chars.length <= width) return s;
  return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

export interface Column {
  header: string;
  align?: "left" | "right";
}

/** Aligned table: header muted, two-space gutters, no borders. */
export function table(columns: Column[], rows: string[][]): string[] {
  const widths = columns.map((col, i) =>
    Math.max(visibleWidth(col.header), ...rows.map((r) => visibleWidth(r[i] ?? ""))),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const w = widths[i] as number;
        const last = i === cells.length - 1;
        if (columns[i]?.align === "right") return padStart(cell, w);
        return last ? cell : padEnd(cell, w);
      })
      .join("  ");
  return [c.muted(fmt(columns.map((col) => col.header))), ...rows.map(fmt)];
}

/** Key/value block: `  page        https://…` */
export function kv(pairs: [string, string][], indent = 2): string[] {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${" ".repeat(indent)}${c.muted(k.padEnd(w))}  ${v}`);
}

// ── spinner ──────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  text(t: string): void;
  stop(): void;
}

function spinnerEnabled(): boolean {
  return !jsonMode && Boolean(process.stderr.isTTY) && !process.env.CI && process.env.TERM !== "dumb";
}

let cursorHidden = false;
function showCursor() {
  if (cursorHidden) {
    process.stderr.write("\x1b[?25h");
    cursorHidden = false;
  }
}
process.on("exit", showCursor);

export function spinner(initial: string): Spinner {
  if (!spinnerEnabled()) return { text() {}, stop() {} };
  let label = initial;
  let i = 0;
  const draw = () => {
    process.stderr.write(`\r\x1b[2K${ce.accent(FRAMES[i % FRAMES.length] as string)} ${ce.muted(label)}`);
    i++;
  };
  process.stderr.write("\x1b[?25l");
  cursorHidden = true;
  draw();
  const timer = setInterval(draw, 80);
  timer.unref?.();
  let stopped = false;
  return {
    text(t) {
      label = t;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stderr.write("\r\x1b[2K");
      showCursor();
    },
  };
}

/** Run `fn` under a spinner; the spinner always stops, even on throw. */
export async function withSpinner<T>(label: string, fn: (s: Spinner) => Promise<T>): Promise<T> {
  const s = spinner(label);
  try {
    return await fn(s);
  } finally {
    s.stop();
  }
}
