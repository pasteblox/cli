import {
  CLI_CLIENT_ID,
  ClaimResponseSchema,
  CliExchangeResponseSchema,
  DEVICE_GRANT_TYPE,
  DeviceCodeResponseSchema,
} from "@pasteblox/shared";
import { Api } from "../lib/api";
import { bool } from "../lib/args";
import { c } from "../lib/color";
import { configPath, getClaims, getHostEntry, removeClaims, setHostEntry, TOKEN_ENV } from "../lib/config";
import { formatUserCode, pollForToken } from "../lib/device";
import { deviceName, openUrl, platformLabel } from "../lib/system";
import { note, out, printJson, printJsonLine, setJsonLines, spinner, success, warn, withSpinner } from "../lib/ui";
import { VERSION } from "../lib/version";
import type { Run } from "./registry";

export const run: Run = async (ctx) => {
  setJsonLines(ctx.json);
  const existing = getHostEntry(ctx.base);
  if (existing && !bool(ctx.flags.force)) {
    if (ctx.json) printJson({ alreadyLoggedIn: true, user: existing.user, api: ctx.base });
    else {
      success(`already logged in as ${c.accent(`@${existing.user.handle}`)} ${c.muted(`on ${ctx.base}`)}`);
      note(`pbx login --force to switch accounts, pbx logout to sign out`);
    }
    return 0;
  }
  if (process.env[TOKEN_ENV]) warn(`${TOKEN_ENV} is set and wins over the key you're about to save`);

  const api = new Api(ctx.base, null);
  const code = await withSpinner("asking for a device code", () =>
    api.request({
      method: "POST",
      path: "/api/auth/device/code",
      body: { client_id: CLI_CLIENT_ID },
      schema: DeviceCodeResponseSchema,
      anonymous: true,
    }),
  );

  const verifyUrl = new URL(code.verification_uri_complete ?? code.verification_uri, `${ctx.base}/`).toString();
  const userCode = formatUserCode(code.user_code);
  const noBrowser = bool(ctx.flags["no-browser"]) || Boolean(process.env.CI);

  if (ctx.json) {
    // stream-friendly: a tool can surface the code before the poll finishes
    process.stdout.write(
      `${JSON.stringify({ event: "device_code", userCode, verificationUri: verifyUrl, expiresIn: code.expires_in })}\n`,
    );
  } else {
    const spaced = userCode.split("").join(" ");
    const inner = `   ${spaced}   `;
    out();
    out(`  ${c.muted(`┌${"─".repeat(inner.length)}┐`)}`);
    out(`  ${c.muted("│")}${c.accent(c.bold(inner))}${c.muted("│")}`);
    out(`  ${c.muted(`└${"─".repeat(inner.length)}┘`)}`);
    out();
    out(`  ${c.muted("confirm this code at")} ${c.link(verifyUrl)}`);
  }

  if (!noBrowser) {
    const opened = await openUrl(verifyUrl);
    if (!ctx.json)
      out(`  ${c.muted(opened ? "opened your browser" : "couldn't open a browser, open the link yourself")}`);
  }
  out();

  const s = spinner(`waiting for you to approve ${userCode}`);
  let token: string;
  try {
    token = await pollForToken({
      interval: code.interval,
      expiresIn: code.expires_in,
      poll: () =>
        api.send({
          method: "POST",
          path: "/api/auth/device/token",
          body: { grant_type: DEVICE_GRANT_TYPE, device_code: code.device_code, client_id: CLI_CLIENT_ID },
          anonymous: true,
        }),
      onHttpError: (res) => api.toError(res, { path: "/api/auth/device/token" }),
      onSlowDown: (i) => s.text(`waiting for you to approve ${userCode} (server asked to slow down: every ${i}s)`),
    });
  } finally {
    s.stop();
  }

  const ex = await withSpinner("creating an api key for this device", () =>
    api.request({
      method: "POST",
      path: api.v1("/cli/exchange"),
      bearer: token,
      body: { deviceName: deviceName(), platform: platformLabel(), cliVersion: VERSION },
      schema: CliExchangeResponseSchema,
    }),
  );
  setHostEntry(ctx.base, {
    apiKey: ex.apiKey,
    keyId: ex.keyId,
    user: { handle: ex.user.handle, name: ex.user.name },
    deviceName: deviceName(),
    createdAt: new Date().toISOString(),
  });

  // claim anonymous scripts pushed from this machine
  let claimed: string[] = [];
  const pending = getClaims(ctx.base);
  if (pending.length) {
    const authed = new Api(ctx.base, { apiKey: ex.apiKey, source: "config" });
    try {
      const res = await authed.request({
        method: "POST",
        path: authed.v1("/claim"),
        body: { items: pending.slice(0, 100).map((p) => ({ slug: p.slug, token: p.token })) },
        schema: ClaimResponseSchema,
      });
      claimed = res.claimed;
      // failed = wrong token / already claimed / deleted: never claimable, so forget them too
      removeClaims(ctx.base, [...res.claimed, ...res.failed]);
    } catch (e) {
      warn(`couldn't claim your anonymous scripts yet (${(e as Error).message}); pbx login --force retries`);
    }
  }

  if (ctx.json) {
    printJsonLine({ event: "logged_in", user: ex.user, keyId: ex.keyId, api: ctx.base, claimed });
    return 0;
  }
  success(`logged in as ${c.accent(`@${ex.user.handle}`)}`);
  note(`key "pbx on ${deviceName()}" saved to ${configPath()}`);
  if (claimed.length) {
    note(`claimed ${claimed.length} anonymous script${claimed.length === 1 ? "" : "s"}: ${claimed.join(", ")}`);
  }
  return 0;
};
