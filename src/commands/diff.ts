import { GetVersionResponseSchema } from "@pasteblox/shared";
import { intFlag } from "../lib/args";
import { c } from "../lib/color";
import { getClaimToken } from "../lib/config";
import { makeApi, resolveRef } from "../lib/context";
import { type DiffLine, unifiedDiff } from "../lib/diff";
import { UsageError } from "../lib/errors";
import { absPath, readText, toProjectPath } from "../lib/project";
import { note, out, printJson, withSpinner } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  if (ctx.args.length > 2) throw new UsageError("diff takes a script and at most one file");
  const ref = resolveRef(ctx.args[0], "diff");
  const { slug, project } = ref;
  const from = intFlag(ctx.flags.from, "from") ?? ref.version;
  const to = intFlag(ctx.flags.to, "to");
  if (to !== undefined && from === undefined)
    throw new UsageError("--to needs --from", `pbx diff ${slug} --from 3 --to 5`);

  // the local side, unless comparing two versions
  let localFile: string | undefined;
  if (to === undefined) {
    const given = ctx.args[1];
    localFile = given ? toProjectPath(project, given) : ref.mapping?.file;
    if (!localFile)
      throw new UsageError(`which local file should ${slug} be compared with?`, `pbx diff ${slug} <file>`);
  }

  const api = makeApi(ctx);
  const claimToken = api.loggedIn ? undefined : getClaimToken(ctx.base, slug);
  const fetchVersion = (n: number | "latest") =>
    api.request({
      path: api.v1(`/scripts/${slug}/versions/${n}`),
      schema: GetVersionResponseSchema,
      claimToken,
      slug,
    });

  const [oldV, newV] = await withSpinner(`fetching ${slug}`, () =>
    Promise.all([fetchVersion(from ?? "latest"), to !== undefined ? fetchVersion(to) : Promise.resolve(null)]),
  );
  const oldText = oldV.version.content;
  const newText = newV ? newV.version.content : readText(absPath(project, localFile as string), localFile);
  const oldLabel = `a/${slug}@${oldV.version.n}`;
  const newLabel = newV ? `b/${slug}@${newV.version.n}` : `b/${localFile}`;
  const d = unifiedDiff(oldText, newText, { oldLabel, newLabel });

  if (ctx.json) {
    printJson({
      slug,
      from: { version: oldV.version.n },
      to: newV ? { version: newV.version.n, file: null } : { version: null, file: localFile },
      changed: d.changed,
      added: d.added,
      removed: d.removed,
      patch: d.lines.map((l) => l.text).join("\n") + (d.changed ? "\n" : ""),
    });
    return 0;
  }
  if (!d.changed) {
    note(`no changes: ${newV ? `v${newV.version.n}` : localFile} matches ${slug}@${oldV.version.n}`);
    return 0;
  }
  for (const line of d.lines) out(paint(line));
  return 0;
};

function paint(l: DiffLine): string {
  switch (l.kind) {
    case "header":
      return c.bold(l.text);
    case "hunk":
      return c.link(l.text);
    case "del":
      return c.error(l.text);
    case "add":
      return c.add(l.text);
    case "meta":
      return c.muted(l.text);
    default:
      return l.text;
  }
}
