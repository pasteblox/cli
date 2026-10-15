/** RFC 8628 polling loop, separated from I/O so it can be tested with a fake clock. */
import { DeviceTokenErrorSchema, DeviceTokenResponseSchema } from "@pasteblox/shared";
import type { RawResponse } from "./api";
import { CliError } from "./errors";

export interface PollOptions {
  /** one POST /api/auth/device/token */
  poll: () => Promise<RawResponse>;
  /** seconds, from the device code response (RFC default 5) */
  interval?: number;
  /** seconds until the device code expires */
  expiresIn: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** non-2xx, non-400 responses */
  onHttpError: (res: RawResponse) => Error;
  onSlowDown?: (intervalS: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function pollForToken(opts: PollOptions): Promise<string> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let interval = Math.max(0, opts.interval ?? 5);
  const deadline = now() + opts.expiresIn * 1000;

  for (;;) {
    await sleep(interval * 1000);
    if (now() > deadline) throw expired();
    const res = await opts.poll();
    if (res.status >= 200 && res.status < 300) {
      const ok = DeviceTokenResponseSchema.safeParse(res.json);
      if (ok.success) return ok.data.access_token;
      throw new CliError("the server sent a token response pbx can't read", {
        hint: "this pbx may be out of date: npm i -g pasteblox@latest",
        code: "bad_response",
      });
    }
    if (res.status === 429) {
      // better-auth's own rate limiter (not RFC 8628): `{"message":"Too many requests…"}` with
      // X-Retry-After. Back off like slow_down and keep polling instead of aborting the login.
      interval += 5;
      opts.onSlowDown?.(interval);
      const extra = (retryAfterSeconds(res.headers) ?? 0) - interval;
      if (extra > 0) await sleep(extra * 1000);
      continue;
    }
    const err = DeviceTokenErrorSchema.safeParse(res.json);
    if (res.status !== 400 && res.status !== 401 && res.status !== 403) throw opts.onHttpError(res);
    if (!err.success) throw opts.onHttpError(res);
    switch (err.data.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        opts.onSlowDown?.(interval);
        continue;
      case "expired_token":
        throw expired();
      case "access_denied":
        throw new CliError("login was denied in the browser", {
          hint: "run pbx login to try again",
          code: "access_denied",
        });
      default:
        throw new CliError(`device login failed: ${err.data.error_description || err.data.error}`, {
          hint: "run pbx login again",
          code: err.data.error,
        });
    }
  }
}

/** Seconds from `Retry-After` (our API) or `X-Retry-After` (better-auth's limiter). */
export function retryAfterSeconds(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after") ?? headers?.get("x-retry-after");
  const n = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}

function expired(): CliError {
  return new CliError("the code expired before anyone approved it", {
    hint: "run pbx login again",
    code: "expired_token",
  });
}

/** better-auth user codes are 8 chars and ignore dashes: show them as ABCD-EFGH. */
export function formatUserCode(code: string): string {
  const clean = code.replace(/[\s-]/g, "").toUpperCase();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
