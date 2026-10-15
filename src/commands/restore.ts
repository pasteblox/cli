import { UpdateScriptResponseSchema } from "@pasteblox/shared";
import { c } from "../lib/color";
import { makeApi, resolveRef } from "../lib/context";
import { notLoggedIn } from "../lib/errors";
import { printJson, success, withSpinner } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  const { slug } = resolveRef(ctx.args[0], "restore");
  const api = makeApi(ctx);
  if (!api.loggedIn) throw notLoggedIn();
  const res = await withSpinner(`restoring ${slug}`, () =>
    api.request({
      method: "POST",
      path: api.v1(`/scripts/${slug}/restore`),
      schema: UpdateScriptResponseSchema,
      slug,
    }),
  );
  if (ctx.json) {
    printJson({ slug, restored: true, script: res });
    return 0;
  }
  success(`restored ${c.accent(slug)}, raw url works again`);
  return 0;
};
