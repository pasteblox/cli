import { ListVersionsResponseSchema, UpdateVersionResponseSchema } from "@pasteblox/shared";
import { intFlag, str } from "../lib/args";
import { c } from "../lib/color";
import { getClaimToken } from "../lib/config";
import { makeApi, resolveRef } from "../lib/context";
import { CliError, UsageError } from "../lib/errors";
import { readNotes, renderNotes } from "../lib/notes";
import { note, out, printJson, success, sym, withSpinner } from "../lib/ui";
import type { Run } from "./registry";

const VERSION_ARG = /^v?\d+$/i;

export const run: Run = async (ctx) => {
  if (ctx.args.length > 2) throw new UsageError("note takes a script and a version", "pbx note <slug> <n> -m <text>");
  // `pbx note 3 …` in a project that maps one script: the lone arg is the version
  const [refArg, nArg] =
    ctx.args.length === 1 && VERSION_ARG.test(ctx.args[0] as string) ? [undefined, ctx.args[0]] : ctx.args;
  const ref = resolveRef(refArg, "note");
  const pinned = nArg === undefined ? undefined : intFlag(nArg, "version");
  if (pinned !== undefined && ref.version !== undefined && pinned !== ref.version)
    throw new UsageError(`${ref.slug}@${ref.version} and ${nArg} name different versions`, "give the version once");

  const message = str(ctx.flags.message);
  const notes = await readNotes(ctx.flags, "note");
  if (message === undefined && notes === undefined) {
    throw new UsageError("nothing to change", 'pass -m "<summary>", --notes <text> or --notes-file <path>');
  }

  const api = makeApi(ctx);
  const claimToken = api.loggedIn ? undefined : getClaimToken(ctx.base, ref.slug);
  const version = await withSpinner(`updating ${ref.slug}`, async () => {
    let n = pinned ?? ref.version;
    if (n === undefined) {
      const page = await api.request({
        path: api.v1(`/scripts/${ref.slug}/versions`),
        query: { limit: 1 },
        schema: ListVersionsResponseSchema,
        claimToken,
        slug: ref.slug,
      });
      n = page.items[0]?.n;
      if (n === undefined) throw new CliError(`${ref.slug} has no versions`);
    }
    const res = await api.request({
      method: "PATCH",
      path: api.v1(`/scripts/${ref.slug}/versions/${n}`),
      body: { ...(message !== undefined ? { message } : {}), ...(notes !== undefined ? { notes } : {}) },
      schema: UpdateVersionResponseSchema,
      claimToken,
      slug: ref.slug,
    });
    return res.version;
  });

  if (ctx.json) {
    printJson({ slug: ref.slug, version });
    return 0;
  }
  success(`${c.accent(ref.slug)} v${version.n} ${c.muted(sym.arrow)} ${version.message || c.muted("(no message)")}`);
  const lines = renderNotes(version.notes, 2);
  if (lines.length) for (const line of lines) out(line);
  else note("no changelog");
  return 0;
};
