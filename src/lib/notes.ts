/**
 * Version changelogs ("notes"): reading them from --notes / --notes-file, and drawing the web's
 * markdown subset (the one the script page renders) in a terminal.
 */
import { MAX_NOTES_LENGTH } from "@pasteblox/shared";
import { type FlagValue, list, str } from "./args";
import { c } from "./color";
import { UsageError } from "./errors";
import { readText } from "./project";

/** CRLF → LF, no BOM, no trailing whitespace per line, trimmed like the server's NotesSchema. */
export function normalizeNotes(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write(`${c.muted("type the notes, then ctrl-d")}\n`);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The notes given on the command line, or undefined when neither flag is set. "" means "clear"
 * (only meaningful to `pbx note`).
 */
export async function readNotes(flags: Record<string, FlagValue>, cmd: string): Promise<string | undefined> {
  const inline = list(flags.notes);
  const file = str(flags["notes-file"]);
  if (inline.length && file !== undefined)
    throw new UsageError("pick one of --notes or --notes-file", `pbx ${cmd} --notes-file CHANGELOG.md`);
  if (!inline.length && file === undefined) return undefined;
  const raw = file === undefined ? inline.join("\n") : file === "-" ? await readStdin() : readText(file);
  const notes = normalizeNotes(raw);
  if (notes.length > MAX_NOTES_LENGTH) {
    throw new UsageError(
      `notes are ${notes.length} characters, over the ${MAX_NOTES_LENGTH} limit`,
      "keep the changelog to what changed; link to longer docs",
    );
  }
  return notes;
}

// ── rendering ────────────────────────────────────────────────────────────────

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,3}\s+(.*)$/;
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
const KIND = /^(\w+)\s*:\s+/;

const KIND_ALIASES: Record<string, "added" | "fixed" | "changed" | "removed"> = {
  added: "added",
  add: "added",
  new: "added",
  fixed: "fixed",
  fix: "fixed",
  changed: "changed",
  change: "changed",
  improved: "changed",
  updated: "changed",
  removed: "removed",
  remove: "removed",
  deleted: "removed",
};

const kindPaint = (kind: string) =>
  kind === "added" ? c.add : kind === "fixed" ? c.accent : kind === "removed" ? c.error : c.link;

function inline(text: string): string {
  return text.replace(INLINE, (tok, code: string | undefined, bold: string | undefined) => {
    if (code) return c.accent(code.slice(1, -1));
    if (bold) return c.bold(bold.slice(2, -2));
    return c.link(tok);
  });
}

function listItem(marker: string, text: string): string {
  const m = KIND.exec(text);
  const kind = m?.[1] ? KIND_ALIASES[m[1].toLowerCase()] : undefined;
  const body = kind && m ? `${kindPaint(kind)(kind)} ${inline(text.slice(m[0].length))}` : inline(text);
  return `${c.muted(marker)} ${body}`;
}

/** Terminal lines for a changelog (no trailing blank lines); [] when there's nothing to show. */
export function renderNotes(text: string, indent = 0): string[] {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const raw of normalizeNotes(text).split("\n")) {
    if (!raw.trim()) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    const h = HEADING.exec(raw);
    const b = BULLET.exec(raw);
    const o = NUMBERED.exec(raw);
    if (h?.[1]) lines.push(c.bold(inline(h[1])));
    else if (b?.[1] !== undefined) lines.push(listItem("•", b[1]));
    else if (o?.[2] !== undefined) lines.push(listItem(`${o[1]}.`, o[2]));
    else lines.push(inline(raw.trim()));
  }
  return lines.map((l) => (l ? pad + l : l));
}
