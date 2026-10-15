import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Visibility } from "@pasteblox/shared";
import { bool, list } from "../lib/args";
import { c } from "../lib/color";
import { visibilityFromFlags } from "../lib/context";
import { CliError, UsageError } from "../lib/errors";
import {
  defaultTitle,
  findMappingByFile,
  findProject,
  type Mapping,
  PROJECT_FILE,
  type Project,
  SCHEMA_URL,
  saveProject,
  toProjectPath,
} from "../lib/project";
import { isInteractive, multiselect, select } from "../lib/prompt";
import { note, out, printJson, success, table, warn } from "../lib/ui";
import type { Run } from "./registry";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "Packages", "DevPackages", "ServerPackages"]);
const MAX_FILES = 2000;

/** .lua/.luau files under root, skipping vendored and hidden dirs. POSIX, sorted. */
export function detectScripts(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || found.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (/\.(luau|lua)$/i.test(e.name)) {
        found.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(root, 0);
  return found.sort();
}

export const run: Run = async (ctx) => {
  const cwd = process.cwd();
  const found = findProject(cwd);
  const project: Project =
    found.root === cwd
      ? found
      : { root: cwd, path: join(cwd, PROJECT_FILE), exists: false, data: { $schema: SCHEMA_URL, scripts: [] } };

  let visibility = visibilityFromFlags(ctx.flags);
  const explicit = list(ctx.flags.file);
  let picked: string[];

  if (explicit.length) {
    picked = explicit.map((f) => {
      const rel = toProjectPath(project, f);
      if (rel.startsWith(".."))
        throw new UsageError(`${f} is outside this directory`, "run pbx init from the project root");
      if (!existsSync(join(project.root, rel)) || !statSync(join(project.root, rel)).isFile()) {
        throw new CliError(`${f} doesn't exist`, { hint: "check the path" });
      }
      if (!/\.(luau|lua)$/i.test(rel)) warn(`${rel} isn't .luau/.lua, mapping it anyway`);
      return rel;
    });
  } else {
    const detected = detectScripts(project.root).filter((f) => !findMappingByFile(project, f));
    if (detected.length === 0) {
      if (project.exists) {
        note(`every .luau/.lua file here is already in ${PROJECT_FILE}`);
        if (ctx.json) printJson({ path: project.path, added: [], scripts: project.data.scripts });
        return 0;
      }
      throw new CliError("no .luau or .lua files found here", { hint: "pbx init -f path/to/script.luau" });
    }
    if (bool(ctx.flags.yes)) picked = detected;
    else if (isInteractive() && !ctx.json) {
      picked = await multiselect(
        `which files should pbx track? ${c.muted(`(${detected.length} found)`)}`,
        detected.map((f) => ({ label: f, value: f })),
        detected.map(() => true),
      );
      if (picked.length === 0) {
        note("nothing selected, nothing written");
        return 0;
      }
      if (!visibility) {
        visibility = await select<Visibility>("default visibility", [
          { label: "unlisted", value: "unlisted", hint: "anyone with the link" },
          { label: "public", value: "public", hint: "listed on explore" },
          { label: "private", value: "private", hint: "only you" },
        ]);
      }
    } else {
      throw new UsageError(
        "pbx init needs --file or --yes outside a terminal",
        "pbx init --yes  or  pbx init -f src/door.luau",
      );
    }
  }

  const added: Mapping[] = [];
  for (const file of picked) {
    if (findMappingByFile(project, file)) continue;
    const m: Mapping = { file, visibility: visibility ?? "unlisted", title: defaultTitle(file) };
    project.data.scripts.push(m);
    added.push(m);
  }
  const existed = project.exists;
  saveProject(project);

  if (ctx.json) {
    printJson({ path: project.path, added, scripts: project.data.scripts });
    return 0;
  }
  success(
    `${existed ? "updated" : "wrote"} ${c.accent(PROJECT_FILE)} ${c.muted(`· ${added.length} new, ${project.data.scripts.length} total`)}`,
  );
  if (added.length) {
    out();
    for (const line of table(
      [{ header: "file" }, { header: "visibility" }, { header: "title" }],
      added.map((m) => [m.file, m.visibility ?? "unlisted", m.title ?? ""]),
    ))
      out(`  ${line}`);
    out();
  }
  note(`next: ${c.accent("pbx push")} creates them and prints the loadstrings`);
  return 0;
};
