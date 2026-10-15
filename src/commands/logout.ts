import { CliRevokeResponseSchema } from "@pasteblox/shared";
import { Api } from "../lib/api";
import { c } from "../lib/color";
import { deleteHostEntry, getHostEntry, TOKEN_ENV } from "../lib/config";
import { CliError } from "../lib/errors";
import { note, printJson, success, warn, withSpinner } from "../lib/ui";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  const entry = getHostEntry(ctx.base);
  const envSet = Boolean(process.env[TOKEN_ENV]);
  if (!entry) {
    if (ctx.json) printJson({ loggedOut: false, revoked: false, reason: "not_logged_in", api: ctx.base });
    else {
      note(`not logged in on ${ctx.base}, nothing to do`);
      if (envSet) note(`${TOKEN_ENV} is set in your environment; unset it to stop using it`);
    }
    return 0;
  }

  const api = new Api(ctx.base, { apiKey: entry.apiKey, source: "config" });
  let revoked: "yes" | "already" | "no" = "no";
  let why = "";
  try {
    await withSpinner("revoking this device's key", () =>
      api.request({ method: "DELETE", path: api.v1("/cli/key"), schema: CliRevokeResponseSchema }),
    );
    revoked = "yes";
  } catch (e) {
    if (e instanceof CliError && e.code === "unauthorized") revoked = "already";
    else why = e instanceof Error ? e.message : String(e);
  }
  deleteHostEntry(ctx.base);

  if (ctx.json) {
    printJson({ loggedOut: true, revoked: revoked !== "no", user: entry.user, api: ctx.base });
    return 0;
  }
  success(`logged out ${c.accent(`@${entry.user.handle}`)}`);
  if (revoked === "yes") note("key revoked on the server");
  else if (revoked === "already") note("key was already revoked");
  else
    warn(
      `couldn't revoke the key server-side (${why}): remove "pbx on ${entry.deviceName ?? "this device"}" in ${ctx.base}/dashboard`,
    );
  if (envSet) note(`${TOKEN_ENV} is still set, so pbx keeps using it`);
  return 0;
};
