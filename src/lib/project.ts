/**
 * Project-level state:
 *   pasteblox.json          committed: which local file maps to which script
 *   .pasteblox/state.json   local only (self-gitignored): last pushed/pulled hash + version per file
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SlugSchema, type Visibility, VisibilitySchema } from "@pasteblox/shared";
import { z } from "zod";
import { CliError } from "./errors";

export const PROJECT_FILE = "pasteblox.json";
export const SCHEMA_URL = "https://pasteblox.com/schema/pasteblox.json";
const STATE_DIR = ".pasteblox";

const MappingSchema = z.object({
  file: z.string().min(1),
  slug: SlugSchema.optional(),
  visibility: VisibilitySchema.optional(),
  title: z.string().optional(),
});
const ProjectFileSchema = z.looseObject({
  $schema: z.string().optional(),
  scripts: z.array(MappingSchema).default([]),
});

export type Mapping = z.infer<typeof MappingSchema>;
export type ProjectData = z.infer<typeof ProjectFileSchema>;

export interface Project {
  root: string;
  path: string;
  exists: boolean;
  data: ProjectData;
}

export interface FileState {
  slug: string;
  sha256: string;
  version: number;
  at: string;
}

interface StateFile {
  version: 1;
  files: Record<string, FileState>;
}

/** Nearest pasteblox.json walking up from cwd; otherwise a fresh (unsaved) project rooted at cwd. */
export function findProject(cwd = process.cwd()): Project {
  let dir = resolve(cwd);
  for (;;) {
    const path = join(dir, PROJECT_FILE);
    if (existsSync(path)) return { root: dir, path, exists: true, data: readProjectFile(path) };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const root = resolve(cwd);
  return { root, path: join(root, PROJECT_FILE), exists: false, data: { $schema: SCHEMA_URL, scripts: [] } };
}

function readProjectFile(path: string): ProjectData {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`${path} isn't valid JSON`, { hint: "fix it, or delete it and run pbx init" });
  }
  const parsed = ProjectFileSchema.safeParse(json);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    const where = i ? i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("") : "";
    throw new CliError(`${PROJECT_FILE}${where}: ${i?.message ?? "invalid"}`, { hint: "fix it, then try again" });
  }
  return parsed.data;
}

export function saveProject(p: Project): void {
  const { $schema, scripts, ...rest } = p.data;
  const ordered = {
    $schema: $schema ?? SCHEMA_URL,
    ...rest,
    scripts: scripts.map((m) => ({
      file: m.file,
      ...(m.slug ? { slug: m.slug } : {}),
      ...(m.visibility ? { visibility: m.visibility } : {}),
      ...(m.title !== undefined ? { title: m.title } : {}),
    })),
  };
  writeFileSync(p.path, `${JSON.stringify(ordered, null, 2)}\n`);
  p.exists = true;
}

/** Project-relative POSIX path for a user-supplied path. */
export function toProjectPath(p: Project, file: string, cwd = process.cwd()): string {
  const abs = isAbsolute(file) ? file : resolve(cwd, file);
  const rel = relative(p.root, abs);
  return rel.split(sep).join("/");
}

export function absPath(p: Project, file: string): string {
  return join(p.root, ...file.split("/"));
}

export function findMappingByFile(p: Project, file: string): Mapping | undefined {
  return p.data.scripts.find((m) => m.file === file);
}

export function findMappingBySlug(p: Project, slug: string): Mapping | undefined {
  return p.data.scripts.find((m) => m.slug === slug);
}

export function upsertMapping(p: Project, m: Mapping): void {
  const i = p.data.scripts.findIndex((x) => x.file === m.file);
  if (i === -1) p.data.scripts.push(m);
  else p.data.scripts[i] = { ...p.data.scripts[i], ...m };
}

export function removeMapping(p: Project, slug: string): Mapping | undefined {
  const i = p.data.scripts.findIndex((x) => x.slug === slug);
  if (i === -1) return undefined;
  return p.data.scripts.splice(i, 1)[0];
}

// ── content ──────────────────────────────────────────────────────────────────

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readText(path: string, label = path): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT")
      throw new CliError(`${label} doesn't exist`, { hint: "check the path (or pbx pull it first)" });
    if (code === "EISDIR") throw new CliError(`${label} is a directory`, { hint: "pass a .luau or .lua file" });
    throw new CliError(`can't read ${label} (${code ?? "unknown error"})`);
  }
}

// ── .pasteblox/state.json ────────────────────────────────────────────────────

function statePath(p: Project): string {
  return join(p.root, STATE_DIR, "state.json");
}

export function readState(p: Project): StateFile {
  try {
    const parsed = JSON.parse(readFileSync(statePath(p), "utf8")) as StateFile;
    if (parsed && typeof parsed.files === "object") return parsed;
  } catch {
    // missing or corrupt: state is a cache, start fresh
  }
  return { version: 1, files: {} };
}

export function writeState(p: Project, state: StateFile): void {
  const dir = join(p.root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# local pbx state, never commit\n*\n");
  const tmp = `${statePath(p)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, statePath(p));
}

export function recordState(p: Project, file: string, entry: Omit<FileState, "at">): void {
  const state = readState(p);
  state.files[file] = { ...entry, at: new Date().toISOString() };
  writeState(p, state);
}

export function forgetState(p: Project, file: string): void {
  const state = readState(p);
  if (state.files[file]) {
    delete state.files[file];
    writeState(p, state);
  }
}

export function defaultTitle(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.(luau|lua|txt)$/i, "");
}

export type { Visibility };
