import { loadstringFor, rawUrl } from "@pasteblox/shared";
import { bool, intFlag } from "../lib/args";
import { c, ce } from "../lib/color";
import { resolveRef } from "../lib/context";
import { copyToClipboard } from "../lib/system";
import { errLine, out, printJson } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  const ref = resolveRef(ctx.args[0], "loadstring");
  const version = intFlag(ctx.flags.version, "version") ?? ref.version;
  const url = rawUrl(ctx.base, ref.slug, version);
  const line = loadstringFor(url);
  const copiedWith = bool(ctx.flags["no-copy"]) ? null : await copyToClipboard(line);

  if (ctx.json) {
    printJson({ slug: ref.slug, version: version ?? null, url, loadstring: line, copied: copiedWith !== null });
    return 0;
  }
  // the one-liner alone on stdout, so `pbx loadstring x | pbcopy` and $(…) stay clean
  out(c.accent(line));
  if (!bool(ctx.flags["no-copy"])) {
    errLine(
      ce.muted(
        copiedWith
          ? `${version ? `pinned to v${version} · ` : ""}copied to clipboard`
          : "no clipboard tool found (pbcopy, wl-copy, xclip, xsel, clip.exe), copy it from above",
      ),
    );
  }
  return 0;
};
