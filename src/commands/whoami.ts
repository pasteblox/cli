import { WhoamiResponseSchema } from "@pasteblox/shared";
import { c } from "../lib/color";
import { makeApi, requireLogin } from "../lib/context";
import { kv, out, printJson, withSpinner } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  const api = makeApi(ctx);
  requireLogin(api);
  const me = await withSpinner("checking", () => api.request({ path: api.v1("/me"), schema: WhoamiResponseSchema }));
  const source = api.auth?.source === "env" ? "PASTEBLOX_TOKEN" : "config";

  if (ctx.json) {
    printJson({ user: me.user, auth: me.auth, api: ctx.base, source });
    return 0;
  }
  const via =
    me.auth.method === "api_key"
      ? `api key${me.auth.keyName ? ` "${me.auth.keyName}"` : ""}${source === "PASTEBLOX_TOKEN" ? " from PASTEBLOX_TOKEN" : ""}`
      : me.auth.method;
  out(
    `${c.accent(`@${me.user.handle}`)}${me.user.name && me.user.name !== me.user.handle ? ` ${c.muted(`(${me.user.name})`)}` : ""}`,
  );
  for (const line of kv([
    ["via", via],
    ["api", ctx.base],
    ...(me.user.role === "admin" ? ([["role", "admin"]] as [string, string][]) : []),
  ]))
    out(line);
  return 0;
};
