/** The push pipeline shared by `pbx push` and `pbx watch`. */
import {
  CreateScriptResponseSchema,
  MAX_SCRIPT_BYTES,
  PushVersionResponseSchema,
  type SafetyFlag,
  type ScriptUrls,
  UpdateScriptResponseSchema,
  utf8ByteLength,
  type Visibility,
} from "@pasteblox/shared";
import type { Api } from "./api";
import { addClaim, getClaimToken } from "./config";
import { CliError } from "./errors";
import {
  absPath,
  defaultTitle,
  findMappingByFile,
  type Project,
  readState,
  readText,
  recordState,
  saveProject,
  sha256,
  upsertMapping,
} from "./project";
import { formatBytes } from "./ui";

export interface PushOptions {
  /** project-relative POSIX path */
  file: string;
  message?: string;
  title?: string;
  visibility?: Visibility;
  /** push into this script (maps the file to it) */
  slug?: string;
  force?: boolean;
}

export interface PushResult {
  file: string;
  slug: string;
  version: number;
  created: boolean;
  unchanged: boolean;
  anonymous: boolean;
  visibility?: Visibility;
  sizeBytes: number;
  ms: number;
  urls: ScriptUrls;
  flags: SafetyFlag[];
}

export function languageFor(file: string): "lua" | "luau" {
  return /\.lua$/i.test(file) ? "lua" : "luau";
}

/** Local pre-flight with the same rules as ScriptContentSchema, but with human messages. */
export function checkContent(file: string, content: string): void {
  if (content.trim().length === 0)
    throw new CliError(`${file} is empty`, { hint: "write some luau first", code: "empty" });
  if (content.includes("\u0000")) {
    throw new CliError(`${file} contains NUL bytes`, {
      hint: "pasteblox stores text scripts only",
      code: "invalid_content",
    });
  }
  const size = utf8ByteLength(content);
  if (size > MAX_SCRIPT_BYTES) {
    throw new CliError(`${file} is ${formatBytes(size)}, over the ${formatBytes(MAX_SCRIPT_BYTES)} limit`, {
      hint: "split it into modules",
      code: "payload_too_large",
    });
  }
}

/** Has the file changed since the last push/pull recorded in .pasteblox/state.json? */
export function isDirty(project: Project, file: string): { dirty: boolean; content: string; hash: string } {
  const content = readText(absPath(project, file), file);
  const hash = sha256(content);
  const mapping = findMappingByFile(project, file);
  const st = readState(project).files[file];
  const dirty = !mapping?.slug || !st || st.slug !== mapping.slug || st.sha256 !== hash;
  return { dirty, content, hash };
}

export async function pushFile(api: Api, project: Project, opts: PushOptions, preloaded?: string): Promise<PushResult> {
  const { file } = opts;
  const content = preloaded ?? readText(absPath(project, file), file);
  checkContent(file, content);
  const mapping = findMappingByFile(project, file);
  const slug = opts.slug ?? mapping?.slug;
  const started = performance.now();

  if (slug) {
    const claimToken = api.loggedIn ? undefined : getClaimToken(api.base, slug);
    if (!api.loggedIn && !claimToken) {
      throw new CliError(`not logged in, and ${slug} wasn't created from this machine`, {
        hint: "run pbx login (or set PASTEBLOX_TOKEN for CI)",
        code: "not_logged_in",
      });
    }
    const st = readState(project).files[file];
    const baseVersion = !opts.force && st && st.slug === slug ? st.version : undefined;
    const res = await api.request({
      method: "POST",
      path: api.v1(`/scripts/${slug}/versions`),
      body: { content, ...(opts.message ? { message: opts.message } : {}), ...(baseVersion ? { baseVersion } : {}) },
      schema: PushVersionResponseSchema,
      claimToken,
      slug,
      baseVersion,
    });

    // explicit metadata flags on an existing script → PATCH
    const patch: { title?: string; visibility?: Visibility } = {};
    if (opts.title !== undefined && opts.title !== mapping?.title) patch.title = opts.title;
    if (opts.visibility && opts.visibility !== mapping?.visibility) patch.visibility = opts.visibility;
    let visibility = mapping?.visibility;
    if (Object.keys(patch).length) {
      const upd = await api.request({
        method: "PATCH",
        path: api.v1(`/scripts/${slug}`),
        body: patch,
        schema: UpdateScriptResponseSchema,
        claimToken,
        slug,
      });
      visibility = upd.script.visibility;
    }

    const nextMapping = {
      file,
      slug,
      ...(visibility ? { visibility } : {}),
      ...(patch.title ? { title: patch.title } : {}),
    };
    const mappingChanged =
      !mapping ||
      mapping.slug !== slug ||
      mapping.visibility !== visibility ||
      (patch.title && mapping.title !== patch.title);
    if (mappingChanged) {
      upsertMapping(project, nextMapping);
      saveProject(project);
    }
    recordState(project, file, { slug, sha256: res.version.sha256, version: res.version.n });
    return {
      file,
      slug,
      version: res.version.n,
      created: false,
      unchanged: res.unchanged,
      anonymous: !api.loggedIn,
      visibility,
      sizeBytes: res.version.sizeBytes,
      ms: Math.round(performance.now() - started),
      urls: res.urls,
      flags: res.version.flags,
    };
  }

  // create
  const visibility = opts.visibility ?? mapping?.visibility ?? "unlisted";
  if (!api.loggedIn && visibility !== "unlisted") {
    throw new CliError(`anonymous scripts are unlisted, but ${file} is set to ${visibility}`, {
      hint: "pbx login first (or push with --unlisted)",
      code: "not_logged_in",
    });
  }
  const title = opts.title ?? mapping?.title ?? defaultTitle(file);
  const res = await api.request({
    method: "POST",
    path: api.v1("/scripts"),
    body: {
      content,
      title,
      visibility,
      language: languageFor(file),
      ...(opts.message ? { message: opts.message } : {}),
    },
    schema: CreateScriptResponseSchema,
  });
  const newSlug = res.script.slug;
  if (res.claimToken) addClaim(api.base, { slug: newSlug, token: res.claimToken, createdAt: new Date().toISOString() });
  upsertMapping(project, { file, slug: newSlug, visibility: res.script.visibility, title: res.script.title || title });
  saveProject(project);
  recordState(project, file, { slug: newSlug, sha256: res.version.sha256, version: res.version.n });
  return {
    file,
    slug: newSlug,
    version: res.version.n,
    created: true,
    unchanged: false,
    anonymous: !api.loggedIn,
    visibility: res.script.visibility,
    sizeBytes: res.version.sizeBytes,
    ms: Math.round(performance.now() - started),
    urls: res.script.urls,
    flags: res.version.flags,
  };
}

const FLAG_TEXT: Partial<Record<SafetyFlag["code"], string>> = {
  discord_webhook: "contains a discord webhook url: anyone with the link can read (and spam) it",
  roblosecurity: "touches .ROBLOSECURITY: if that's your own cookie, log out of roblox now to rotate it",
  ip_logger: "links a known ip logger",
  http_exfil: "sends http requests to a non-roblox host",
  env_tamper: "mixes getfenv/setfenv with loadstring",
  escape_run: "has a long escape-sequence run (reads as obfuscated)",
  blob_line: "has a huge single-line blob",
};

/** Human warnings for warn/high safety flags (info flags are page chips only). */
export function flagWarnings(file: string, flags: SafetyFlag[]): string[] {
  return flags
    .filter((f) => f.severity !== "info")
    .map((f) => `${file}${f.line ? `:${f.line}` : ""} ${FLAG_TEXT[f.code] ?? f.code.replace(/_/g, " ")}`);
}
