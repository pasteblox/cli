import { ListVersionsResponseSchema, MAX_PAGE_SIZE, type VersionMeta } from "@pasteblox/shared";
import { bool, intFlag } from "../lib/args";
import { c } from "../lib/color";
import { getClaimToken } from "../lib/config";
import { makeApi, resolveRef } from "../lib/context";
import { renderNotes } from "../lib/notes";
import { ago, formatBytes, note, out, padEnd, padStart, printJson, withSpinner } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  const ref = resolveRef(ctx.args[0], "log");
  const limit = intFlag(ctx.flags.limit, "limit") ?? 20;
  const short = bool(ctx.flags.short);
  const api = makeApi(ctx);
  const claimToken = api.loggedIn ? undefined : getClaimToken(ctx.base, ref.slug);

  const versions: VersionMeta[] = [];
  let cursor: string | undefined;
  await withSpinner(`loading history for ${ref.slug}`, async () => {
    do {
      const page = await api.request({
        path: api.v1(`/scripts/${ref.slug}/versions`),
        query: { cursor, limit: Math.min(MAX_PAGE_SIZE, limit - versions.length) },
        schema: ListVersionsResponseSchema,
        claimToken,
        slug: ref.slug,
      });
      versions.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && versions.length < limit);
  });

  if (ctx.json) {
    printJson({ slug: ref.slug, versions, nextCursor: cursor ?? null });
    return 0;
  }
  const nW = Math.max(...versions.map((v) => String(v.n).length)) + 1;
  const agoW = Math.max(...versions.map((v) => ago(v.createdAt).length));
  const sizeW = Math.max(...versions.map((v) => formatBytes(v.sizeBytes).length));
  // notes hang under the summary column, so the version/age/size columns stay scannable
  const indent = nW + agoW + sizeW + 6;
  versions.forEach((v, i) => {
    const flagged = v.flags.some((f) => f.severity === "high") ? ` ${c.error("!")}` : "";
    const who = v.author ? ` ${c.muted(`@${v.author.handle}`)}` : "";
    const src = v.source !== "cli" ? ` ${c.muted(`[${v.source}]`)}` : "";
    out(
      `${c.accent(padEnd(`v${v.n}`, nW))}  ${c.muted(padEnd(ago(v.createdAt), agoW))}  ${c.muted(padStart(formatBytes(v.sizeBytes), sizeW))}  ${v.message || c.muted("(no message)")}${src}${who}${flagged}`,
    );
    const notes = short ? [] : renderNotes(v.notes, indent);
    for (const line of notes) out(line);
    if (notes.length && i < versions.length - 1) out();
  });
  if (cursor) note(`older versions exist: pbx log ${ref.slug} -n ${limit * 2}`);
  return 0;
};
