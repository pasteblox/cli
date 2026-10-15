import { rawUrl } from "@pasteblox/shared";
import { bool } from "../lib/args";
import { c } from "../lib/color";
import { resolveRef } from "../lib/context";
import { openUrl } from "../lib/system";
import { note, out, printJson } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  const ref = resolveRef(ctx.args[0], "open");
  const url = bool(ctx.flags.raw)
    ? rawUrl(ctx.base, ref.slug, ref.version)
    : `${ctx.base}/s/${ref.slug}${ref.version ? `?v=${ref.version}` : ""}`;
  const opened = await openUrl(url);
  if (ctx.json) printJson({ slug: ref.slug, url, opened });
  else {
    out(c.link(url));
    if (!opened) note("couldn't open a browser, the link is above");
  }
  return 0;
};
