import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { GetScriptResponseSchema, GetVersionResponseSchema } from "@pasteblox/shared";
import { bool, intFlag, str } from "../lib/args";
import { c } from "../lib/color";
import { getClaimToken } from "../lib/config";
import { makeApi, resolveRef } from "../lib/context";
import { CliError } from "../lib/errors";
import {
  absPath,
  findMappingByFile,
  readState,
  readText,
  recordState,
  saveProject,
  sha256,
  toProjectPath,
  upsertMapping,
} from "../lib/project";
import { formatBytes, note, printJson, success, sym, withSpinner } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  const ref = resolveRef(ctx.args[0], "pull");
  const { project, slug } = ref;
  const pinned = intFlag(ctx.flags.version, "version") ?? ref.version;
  const api = makeApi(ctx);
  const claimToken = api.loggedIn ? undefined : getClaimToken(ctx.base, slug);

  const [meta, ver] = await withSpinner(`fetching ${slug}${pinned ? `@${pinned}` : ""}`, () =>
    Promise.all([
      api.request({
        path: api.v1(`/scripts/${slug}`),
        query: { versions: 0 },
        schema: GetScriptResponseSchema,
        claimToken,
        slug,
      }),
      api.request({
        path: api.v1(`/scripts/${slug}/versions/${pinned ?? "latest"}`),
        schema: GetVersionResponseSchema,
        claimToken,
        slug,
      }),
    ]),
  );
  const script = meta.script;
  const remote = ver.version;

  // where to write
  const output = str(ctx.flags.output);
  const ext = script.language === "lua" ? "lua" : "luau";
  const target = output
    ? isAbsolute(output)
      ? output
      : resolve(process.cwd(), output)
    : ref.mapping
      ? absPath(project, ref.mapping.file)
      : resolve(process.cwd(), `${slug}.${ext}`);
  const rel = toProjectPath(project, target);
  const inProject = !rel.startsWith("..");
  const label = inProject ? rel : target;

  const remoteHash = sha256(remote.content);
  let upToDate = false;
  if (existsSync(target)) {
    const local = readText(target, label);
    const localHash = sha256(local);
    if (localHash === remoteHash) upToDate = true;
    else if (!bool(ctx.flags.force)) {
      const st = inProject ? readState(project).files[rel] : undefined;
      const clean = st !== undefined && st.sha256 === localHash;
      if (!clean) {
        throw new CliError(`${label} has local changes that aren't pushed`, {
          hint: `pbx diff ${slug} to see them, pbx push to keep them, or pull --force to overwrite`,
          code: "local_changes",
        });
      }
    }
  }

  if (!upToDate) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, remote.content);
  }

  let mapped = false;
  if (inProject) {
    // remember what we have, based on the latest version we've seen (so the next push isn't a conflict)
    recordState(project, rel, { slug, sha256: remoteHash, version: script.latestVersion });
    if (project.exists && script.viewer.canEdit && !findMappingByFile(project, rel) && !ref.mapping) {
      upsertMapping(project, { file: rel, slug, visibility: script.visibility, title: script.title });
      saveProject(project);
      mapped = true;
    }
  }

  if (ctx.json) {
    printJson({
      slug,
      version: remote.n,
      latestVersion: script.latestVersion,
      file: target,
      sizeBytes: remote.sizeBytes,
      sha256: remoteHash,
      written: !upToDate,
      mapped,
    });
    return 0;
  }
  if (upToDate) success(`${label} already matches ${c.accent(slug)} v${remote.n}`);
  else {
    success(
      `${c.accent(slug)} v${remote.n} ${c.muted(sym.arrow)} ${label} ${c.muted(`· ${formatBytes(remote.sizeBytes)}`)}`,
    );
  }
  if (pinned && pinned !== script.latestVersion) note(`pinned v${pinned}; latest is v${script.latestVersion}`);
  if (mapped) note(`mapped ${label} in pasteblox.json, so pbx push updates it`);
  return 0;
};
