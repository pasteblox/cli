import {
  ListScriptsResponseSchema,
  MAX_PAGE_SIZE,
  SCRIPT_SORTS,
  type ScriptSummary,
  VISIBILITIES,
} from "@pasteblox/shared";
import { intFlag, str } from "../lib/args";
import { c } from "../lib/color";
import { makeApi, requireLogin } from "../lib/context";
import { UsageError } from "../lib/errors";
import { ago, formatCount, note, out, printJson, table, truncate, withSpinner } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  const visibility = str(ctx.flags.visibility);
  if (visibility && !(VISIBILITIES as readonly string[]).includes(visibility)) {
    throw new UsageError(`--visibility must be one of ${VISIBILITIES.join(", ")}`);
  }
  const sort = str(ctx.flags.sort) ?? "updated";
  if (!(SCRIPT_SORTS as readonly string[]).includes(sort)) {
    throw new UsageError(`--sort must be one of ${SCRIPT_SORTS.join(", ")}`);
  }
  const limit = intFlag(ctx.flags.limit, "limit") ?? 100;

  const api = makeApi(ctx);
  requireLogin(api);

  const scripts: ScriptSummary[] = [];
  let cursor: string | undefined;
  let more = false;
  await withSpinner("loading your scripts", async (s) => {
    do {
      const page = await api.request({
        path: api.v1("/me/scripts"),
        query: { visibility, sort, cursor, limit: Math.min(MAX_PAGE_SIZE, limit - scripts.length) },
        schema: ListScriptsResponseSchema,
      });
      scripts.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      s.text(`loading your scripts (${scripts.length})`);
    } while (cursor && scripts.length < limit);
    more = Boolean(cursor);
  });

  if (ctx.json) {
    printJson({ scripts, nextCursor: cursor ?? null });
    return 0;
  }
  if (scripts.length === 0) {
    note(visibility ? `no ${visibility} scripts yet` : `no scripts yet: ${c.accent("pbx push <file>")} makes one`);
    return 0;
  }
  const width = process.stdout.columns ?? 100;
  const titleWidth = Math.max(12, Math.min(40, width - 60));
  const rows = scripts.map((s) => [
    truncate(s.title || c.muted("untitled"), titleWidth),
    c.accent(s.slug),
    visTag(s.visibility),
    `v${s.latestVersion}`,
    formatCount(s.viewCount),
    c.muted(ago(s.updatedAt)),
  ]);
  for (const line of table(
    [
      { header: "title" },
      { header: "slug" },
      { header: "visibility" },
      { header: "ver", align: "right" },
      { header: "views", align: "right" },
      { header: "updated" },
    ],
    rows,
  ))
    out(line);
  if (more) note(`showing ${scripts.length}; pbx ls -n ${limit * 2} for more`);
  return 0;
};

function visTag(v: string): string {
  return v === "public" ? v : c.muted(v);
}
