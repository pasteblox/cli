import { DeleteScriptResponseSchema, GetScriptResponseSchema } from "@pasteblox/shared";
import { bool } from "../lib/args";
import { c } from "../lib/color";
import { getClaimToken, removeClaims } from "../lib/config";
import { makeApi, resolveRef } from "../lib/context";
import { CliError, notLoggedIn, UsageError } from "../lib/errors";
import { forgetState, removeMapping, saveProject } from "../lib/project";
import { confirm, isInteractive } from "../lib/prompt";
import { note, printJson, success, withSpinner } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  const ref = resolveRef(ctx.args[0], "rm");
  const { slug, project } = ref;
  const api = makeApi(ctx);
  const claimToken = api.loggedIn ? undefined : getClaimToken(ctx.base, slug);
  if (!api.loggedIn && !claimToken) throw notLoggedIn();

  const { script } = await withSpinner(`looking up ${slug}`, () =>
    api.request({
      path: api.v1(`/scripts/${slug}`),
      query: { versions: 0 },
      schema: GetScriptResponseSchema,
      claimToken,
      slug,
    }),
  );
  if (!script.viewer.canEdit) {
    throw new CliError(`${slug} isn't yours to delete`, { hint: "check the slug with pbx ls", code: "forbidden" });
  }

  if (!bool(ctx.flags.yes)) {
    if (!isInteractive() || ctx.json) {
      throw new UsageError("refusing to delete without confirmation", `pbx rm ${slug} --yes`);
    }
    const name = script.title ? `"${script.title}" (${slug})` : slug;
    const extra = script.fetchCount > 0 ? `, it was fetched ${script.fetchCount} times` : "";
    const ok = await confirm(`delete ${name}? its raw url stops working right away${extra}`);
    if (!ok) {
      note("kept it");
      return 0;
    }
  }

  const res = await withSpinner(`deleting ${slug}`, () =>
    api.request({
      method: "DELETE",
      path: api.v1(`/scripts/${slug}`),
      schema: DeleteScriptResponseSchema,
      claimToken,
      slug,
    }),
  );
  removeClaims(ctx.base, [slug]);
  const unmapped = removeMapping(project, slug);
  if (unmapped) {
    saveProject(project);
    forgetState(project, unmapped.file);
  }

  if (ctx.json) {
    printJson({ slug, deleted: true, purgeAfter: res.purgeAfter, unmapped: unmapped?.file ?? null });
    return 0;
  }
  const purge = new Date(res.purgeAfter).toISOString().slice(0, 10);
  success(`deleted ${c.accent(slug)}${script.title ? ` ${c.muted(`(${script.title})`)}` : ""}`);
  note(`soft-deleted until ${purge}, then gone for good. changed your mind? pbx restore ${slug}`);
  if (unmapped) note(`unmapped ${unmapped.file} (the file itself is untouched)`);
  return 0;
};
