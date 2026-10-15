/** Helpers shared by commands: api client construction and "which script did you mean". */
import { parseRawRef, SLUG_REGEX, type Visibility } from "@pasteblox/shared";
import type { CommandContext } from "../commands/registry";
import { Api } from "./api";
import type { FlagValue } from "./args";
import { resolveAuth } from "./config";
import { CliError, notLoggedIn, UsageError } from "./errors";
import {
  findMappingByFile,
  findMappingBySlug,
  findProject,
  type Mapping,
  type Project,
  toProjectPath,
} from "./project";

export function makeApi(ctx: CommandContext): Api {
  return new Api(ctx.base, resolveAuth(ctx.base));
}

export function requireLogin(api: Api): void {
  if (!api.loggedIn) throw notLoggedIn();
}

const VIS = ["public", "unlisted", "private"] as const;
export function visibilityFromFlags(flags: Record<string, FlagValue>): Visibility | undefined {
  const set = VIS.filter((v) => flags[v] === true);
  if (set.length > 1) throw new UsageError("pick one of --public, --unlisted or --private");
  return set[0];
}

export interface ScriptRef {
  slug: string;
  /** from slug@n or a pinned raw url */
  version?: number;
  mapping?: Mapping;
  project: Project;
}

/**
 * Accepts a slug, slug@n, a page/raw url, or a mapped file path. With no argument and exactly
 * one pushed mapping in pasteblox.json, uses that.
 */
export function resolveRef(arg: string | undefined, cmd: string, project = findProject()): ScriptRef {
  if (!arg) {
    const pushed = project.data.scripts.filter((m) => m.slug);
    if (pushed.length === 1) {
      const m = pushed[0] as Mapping;
      return { slug: m.slug as string, mapping: m, project };
    }
    throw new UsageError("which script?", `pbx ${cmd} <slug>  (a slug, a url, or a mapped file)`);
  }

  let candidate = arg.trim();
  if (/^https?:\/\//i.test(candidate)) {
    let path: string;
    try {
      path = new URL(candidate).pathname;
    } catch {
      throw new UsageError(`"${arg}" isn't a valid url`);
    }
    const m = /^\/(?:s|raw)\/([^/]+)(?:\/(v?\d+))?\/?$/.exec(path);
    if (!m)
      throw new UsageError(`"${arg}" doesn't look like a pasteblox script url`, "expected …/s/<slug> or …/raw/<slug>");
    candidate = m[2] ? `${m[1]}@${m[2]}` : (m[1] as string);
  }

  const lower = candidate.toLowerCase();
  if (SLUG_REGEX.test(lower) || (lower.includes("@") && SLUG_REGEX.test(lower.split("@")[0] as string))) {
    const ref = parseRawRef(lower);
    if (!ref) throw new UsageError(`"${arg}" isn't a valid slug or slug@version`);
    return {
      slug: ref.slug,
      version: ref.version ?? undefined,
      mapping: findMappingBySlug(project, ref.slug),
      project,
    };
  }

  const file = toProjectPath(project, candidate);
  const mapping = findMappingByFile(project, file);
  if (mapping?.slug) return { slug: mapping.slug, mapping, project };
  if (mapping) throw new CliError(`${file} isn't pushed yet`, { hint: `pbx push ${file}` });
  throw new UsageError(`"${arg}" isn't a slug or a mapped file`, "slugs are 10 chars like k3m9x2p7qa; see pbx ls");
}
