import { existsSync, type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { c } from "../lib/color";
import { makeApi } from "../lib/context";
import { CliError, UsageError } from "../lib/errors";
import { absPath, findProject, PROJECT_FILE } from "../lib/project";
import { flagWarnings, isDirty, pushFile } from "../lib/pusher";
import {
  clock,
  errLine,
  formatBytes,
  note,
  out,
  printJsonLine,
  renderError,
  setJsonLines,
  success,
  sym,
  warn,
} from "../lib/ui";
import type { Run } from "./registry";

const DEBOUNCE_MS = 400;

export const run: Run = async (ctx) => {
  setJsonLines(ctx.json);
  const project = findProject();
  if (!project.exists || project.data.scripts.length === 0) {
    throw new UsageError(`nothing to watch: no ${PROJECT_FILE} with mapped files here`, "pbx init first");
  }
  const api = makeApi(ctx);
  const emit = (event: Record<string, unknown>) => {
    if (ctx.json) printJsonLine({ ...event, at: new Date().toISOString() });
  };

  // watch parent directories, not files: editors that save via rename would orphan a file watcher
  const byDirEntry = new Map<string, string>();
  const dirs = new Set<string>();
  for (const m of project.data.scripts) {
    const abs = absPath(project, m.file);
    byDirEntry.set(`${dirname(abs)}\0${basename(abs)}`, m.file);
    dirs.add(dirname(abs));
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Set<string>();
  const again = new Set<string>();
  let stopping = false;

  const schedule = (file: string, delay = DEBOUNCE_MS) => {
    if (stopping) return;
    const t = timers.get(file);
    if (t) clearTimeout(t);
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        void trigger(file);
      }, delay),
    );
  };

  const trigger = async (file: string) => {
    if (inflight.has(file)) {
      again.add(file);
      return;
    }
    inflight.add(file);
    try {
      if (!existsSync(absPath(project, file))) return; // mid-rename or deleted; the next event brings it back
      const state = isDirty(project, file);
      if (!state.dirty) return;
      const res = await pushFile(api, project, { file, message: `watch: ${clock()}` }, state.content);
      if (ctx.json) emit({ event: "push", ...res });
      else if (res.unchanged) out(`${c.muted(sym.dot)} ${basename(file)} unchanged ${c.muted(`v${res.version}`)}`);
      else {
        const name = res.created
          ? `${basename(file)} ${c.muted(sym.arrow)} ${c.accent(res.slug)} v${res.version}`
          : `${basename(file)} ${c.muted(sym.arrow)} ${c.accent(`v${res.version}`)}`;
        success(`${name} ${c.muted(`· ${formatBytes(res.sizeBytes)} · ${res.ms}ms · ${clock()}`)}`);
        if (res.created) out(`  ${c.muted("loadstring")}  ${c.accent(res.urls.loadstring)}`);
        for (const w of flagWarnings(file, res.flags)) warn(w);
      }
    } catch (e) {
      const err = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e));
      emit({ event: "error", file, code: err.code, message: err.message, hint: err.hint ?? null });
      if (!ctx.json) errLine(renderError(new CliError(`${basename(file)}: ${err.message}`, { hint: err.hint })));
      const retry = Number(err.details?.retryAfter);
      if (err.code === "rate_limited" && Number.isFinite(retry)) {
        if (!ctx.json) note(`retrying ${basename(file)} in ${retry}s`);
        schedule(file, retry * 1000 + 50);
      }
    } finally {
      inflight.delete(file);
      if (again.delete(file)) schedule(file);
    }
  };

  const watchers: FSWatcher[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      warn(`${dir} doesn't exist, skipping it`);
      continue;
    }
    try {
      const w = watch(dir, { persistent: true }, (_event, filename) => {
        if (!filename) return;
        const file = byDirEntry.get(`${dir}\0${basename(filename.toString())}`);
        if (file) schedule(file);
      });
      w.on("error", (e) => warn(`watcher for ${dir} failed: ${e.message}`));
      watchers.push(w);
    } catch (e) {
      warn(`can't watch ${dir}: ${(e as Error).message}`);
    }
  }
  if (watchers.length === 0)
    throw new CliError("none of the mapped files' folders exist", { hint: `check ${PROJECT_FILE}` });

  const files = project.data.scripts.map((m) => m.file);
  emit({ event: "watching", files, api: ctx.base });
  if (!ctx.json) {
    out(
      `${c.accent("●")} watching ${files.length} file${files.length === 1 ? "" : "s"} ${c.muted(`(${files.map((f) => basename(f)).join(", ")})`)}`,
    );
    out(c.muted(`  pushes ${DEBOUNCE_MS}ms after you save · ctrl-c to stop${api.loggedIn ? "" : " · not logged in"}`));
  }

  return await new Promise<number>((resolve) => {
    const stop = () => {
      if (stopping) return;
      stopping = true;
      for (const w of watchers) w.close();
      for (const t of timers.values()) clearTimeout(t);
      emit({ event: "stopped" });
      if (!ctx.json) {
        if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K"); // eat the ^C echo
        out(c.muted("stopped watching"));
      }
      resolve(0);
      // an in-flight push may hold the event loop open: don't wait on it
      setTimeout(() => process.exit(0), 250).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
};
