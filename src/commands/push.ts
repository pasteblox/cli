import { SLUG_REGEX } from "@pasteblox/shared";
import { bool, str } from "../lib/args";
import { c } from "../lib/color";
import { claimsPath } from "../lib/config";
import { makeApi, visibilityFromFlags } from "../lib/context";
import { CliError, UsageError } from "../lib/errors";
import { findProject, PROJECT_FILE, toProjectPath } from "../lib/project";
import { flagWarnings, isDirty, type PushResult, pushFile } from "../lib/pusher";
import {
  errLine,
  formatBytes,
  kv,
  note,
  out,
  printJson,
  renderError,
  success,
  sym,
  warn,
  withSpinner,
} from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  if (ctx.args.length > 1)
    throw new UsageError("push takes one file at a time", "or no file to push everything that changed");
  const api = makeApi(ctx);
  const project = findProject();
  const message = str(ctx.flags.message);
  const title = str(ctx.flags.title);
  const visibility = visibilityFromFlags(ctx.flags);
  const force = bool(ctx.flags.force);
  const slug = str(ctx.flags.slug)?.toLowerCase();
  if (slug !== undefined && !SLUG_REGEX.test(slug))
    throw new UsageError(`"${slug}" isn't a valid slug`, "slugs are 10 chars like k3m9x2p7qa");

  // ── single file ────────────────────────────────────────────────────────────
  const arg = ctx.args[0];
  if (arg) {
    const file = toProjectPath(project, arg);
    if (file.startsWith("..")) {
      throw new UsageError(
        `${arg} is outside the project at ${project.root}`,
        "run pbx from the folder that holds the file",
      );
    }
    const res = await withSpinner(`pushing ${file}`, () =>
      pushFile(api, project, { file, message, title, visibility, slug, force }),
    );
    if (ctx.json) printJson({ pushed: [res], skipped: [], errors: [] });
    else printResult(res, true);
    return 0;
  }

  // ── everything that changed ────────────────────────────────────────────────
  if (slug || title) throw new UsageError("--slug and --title need a file", "pbx push <file> --slug <slug>");
  if (visibility) throw new UsageError("visibility flags need a file", "pbx push <file> --public");
  if (!project.exists || project.data.scripts.length === 0) {
    throw new UsageError(
      `nothing to push: no ${PROJECT_FILE} with mapped files here`,
      "pbx push <file>, or pbx init to map a folder",
    );
  }

  const pushed: PushResult[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const errors: { file: string; code: string; message: string; hint?: string }[] = [];
  for (const m of project.data.scripts) {
    let state: ReturnType<typeof isDirty>;
    try {
      state = isDirty(project, m.file);
    } catch (e) {
      const err = e as CliError;
      errors.push({ file: m.file, code: err.code ?? "error", message: err.message, hint: err.hint });
      if (!ctx.json) errLine(renderError(err));
      continue;
    }
    if (!state.dirty) {
      skipped.push({ file: m.file, reason: "unchanged" });
      continue;
    }
    try {
      const res = await withSpinner(`pushing ${m.file}`, () =>
        pushFile(api, project, { file: m.file, message, force }, state.content),
      );
      pushed.push(res);
      if (!ctx.json) printResult(res, false);
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      errors.push({ file: m.file, code: e.code, message: e.message, hint: e.hint });
      if (!ctx.json) errLine(renderError(new CliError(`${m.file}: ${e.message}`, { hint: e.hint })));
      if (e.code === "not_logged_in" || e.code === "network") break; // the rest will fail the same way
    }
  }

  if (ctx.json) printJson({ pushed, skipped, errors });
  else if (pushed.length === 0 && errors.length === 0) {
    success(`everything's up to date ${c.muted(`(${skipped.length} file${skipped.length === 1 ? "" : "s"})`)}`);
  } else if (skipped.length) note(`${skipped.length} unchanged`);
  return errors.length ? 1 : 0;
};

export function printResult(res: PushResult, detailed: boolean): void {
  const meta = c.muted(`· ${formatBytes(res.sizeBytes)} · ${res.ms}ms`);
  if (res.unchanged) {
    out(`${c.muted(sym.dot)} ${res.file} unchanged ${c.muted(`(still v${res.version})`)}`);
  } else if (res.created) {
    success(
      `${res.file} ${c.muted(sym.arrow)} ${c.accent(res.slug)} v${res.version} ${c.muted(`· new ${res.visibility ?? ""} script`)} ${meta}`,
    );
  } else {
    success(`${res.file} ${c.muted(sym.arrow)} ${c.accent(`v${res.version}`)} ${meta}`);
  }
  if (detailed || res.created) {
    for (const line of kv([
      ["slug", res.slug],
      ["page", c.link(res.urls.page)],
      ["raw", c.link(res.urls.raw)],
      ["loadstring", c.accent(res.urls.loadstring)],
    ]))
      out(line);
  }
  for (const w of flagWarnings(res.file, res.flags)) warn(w);
  if (res.created && res.anonymous) {
    note(
      `anonymous script: ${c.accent("pbx login")} claims it to your account ${c.muted(`(edit token in ${claimsPath()})`)}`,
    );
  }
}
