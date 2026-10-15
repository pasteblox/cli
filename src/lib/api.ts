/**
 * /api/v1 client. Every 2xx body is parsed with the shared Zod contract; every non-2xx body
 * is mapped from ApiErrorSchema to a message that says what to do next.
 */
import {
  API_BASE_PATH,
  ApiErrorSchema,
  type ErrorCode,
  HEADER_API_KEY,
  HEADER_CLAIM_TOKEN,
  MAX_SCRIPT_BYTES,
} from "@pasteblox/shared";
import type { z } from "zod";
import type { ResolvedAuth } from "./config";
import { retryAfterSeconds } from "./device";
import { CliError } from "./errors";
import { formatBytes } from "./ui";
import { VERSION } from "./version";

export const USER_AGENT = `pbx/${VERSION} (${process.platform} ${process.arch}; node ${process.versions.node})`;
const TIMEOUT_MS = 30_000;

export interface RequestOptions<S extends z.ZodType | null> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** absolute path on the host, e.g. /api/v1/scripts or /api/auth/device/code */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  schema: S;
  /** override auth for this call */
  bearer?: string;
  claimToken?: string;
  /** skip x-api-key even when logged in */
  anonymous?: boolean;
  /** context for friendlier errors */
  slug?: string;
  baseVersion?: number;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  json: unknown;
}

export class Api {
  constructor(
    readonly base: string,
    readonly auth: ResolvedAuth | null,
  ) {}

  get loggedIn(): boolean {
    return this.auth !== null;
  }

  v1(path: string): string {
    return `${API_BASE_PATH}${path}`;
  }

  /** fetch + JSON decode; no status handling (the device flow needs 400 bodies). */
  async send(opts: Omit<RequestOptions<null>, "schema">): Promise<RawResponse> {
    const url = new URL(opts.path, `${this.base}/`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    else if (this.auth && !opts.anonymous) headers[HEADER_API_KEY] = this.auth.apiKey;
    if (opts.claimToken) headers[HEADER_CLAIM_TOKEN] = opts.claimToken;

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (e) {
      throw networkError(this.base, e);
    }
    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (json === undefined && text && res.ok) {
      throw new CliError(`${this.base} answered ${res.status} with something that isn't JSON`, {
        hint: "is --api / PASTEBLOX_API pointing at a pasteblox server?",
        code: "bad_response",
      });
    }
    return { status: res.status, headers: res.headers, json };
  }

  async request<S extends z.ZodType>(opts: RequestOptions<S>): Promise<z.infer<S>> {
    const res = await this.send(opts);
    if (res.status < 200 || res.status >= 300) throw this.toError(res, opts);
    const parsed = opts.schema.safeParse(res.json);
    if (!parsed.success) {
      if (process.env.PBX_DEBUG) process.stderr.write(`${JSON.stringify(parsed.error.issues, null, 2)}\n`);
      throw new CliError(`unexpected response from ${opts.method ?? "GET"} ${opts.path}`, {
        hint: "this pbx may be out of date: npm i -g pasteblox@latest (PBX_DEBUG=1 for details)",
        code: "bad_response",
      });
    }
    return parsed.data;
  }

  toError(res: RawResponse, opts: Pick<RequestOptions<null>, "slug" | "baseVersion" | "path" | "bearer">): CliError {
    const parsed = ApiErrorSchema.safeParse(res.json);
    if (!parsed.success) {
      if (res.status === 429) {
        // better-auth's limiter on /api/auth/*: {"message":"Too many requests…"} + X-Retry-After
        const retryAfter = retryAfterSeconds(res.headers);
        return new CliError(`rate limited${retryAfter ? `, retry in ${retryAfter}s` : ""}`, {
          hint: "wait a bit and try again",
          code: "rate_limited",
          details: { status: 429, ...(retryAfter !== undefined ? { retryAfter } : {}) },
        });
      }
      if (res.status === 404 && !opts.slug) {
        return new CliError(`${this.base} doesn't know ${opts.path} (404)`, {
          hint: "is --api / PASTEBLOX_API pointing at a pasteblox server?",
          code: "not_found",
        });
      }
      if (res.status >= 500) {
        return new CliError(`pasteblox had a moment (${res.status})`, { hint: "try again in a bit", code: "internal" });
      }
      return new CliError(`unexpected ${res.status} from ${opts.path}`, {
        hint: "is --api / PASTEBLOX_API pointing at a pasteblox server?",
        code: "bad_response",
      });
    }
    const e = parsed.data.error;
    const retryHeader = Number(res.headers.get("retry-after"));
    const details: Record<string, unknown> = { status: res.status };
    if (e.retryAfter !== undefined || Number.isFinite(retryHeader)) details.retryAfter = e.retryAfter ?? retryHeader;
    if (e.latestVersion !== undefined) details.latestVersion = e.latestVersion;
    if (e.issues) details.issues = e.issues;
    return new CliError(...friendly(e.code, e.message, { ...opts, auth: this.auth, details }));
  }
}

interface FriendlyCtx {
  slug?: string;
  baseVersion?: number;
  bearer?: string;
  auth: ResolvedAuth | null;
  details: Record<string, unknown>;
}

function friendly(
  code: ErrorCode,
  serverMsg: string,
  ctx: FriendlyCtx,
): [string, ConstructorParameters<typeof CliError>[1]] {
  const base = { code, details: ctx.details };
  const script = ctx.slug ? `script ${ctx.slug}` : "script";
  switch (code) {
    case "unauthorized":
      if (ctx.bearer)
        return ["the login session expired before it was exchanged", { ...base, hint: "run pbx login again" }];
      if (!ctx.auth) return ["not logged in", { ...base, hint: "run pbx login (or set PASTEBLOX_TOKEN for CI)" }];
      if (ctx.auth.source === "env") {
        return ["PASTEBLOX_TOKEN was rejected", { ...base, hint: "create a fresh key in the dashboard, or unset it" }];
      }
      return ["your saved key was rejected (revoked?)", { ...base, hint: "run pbx login again" }];
    case "forbidden":
      return [
        ctx.slug ? `you can't change ${ctx.slug}` : serverMsg || "not allowed",
        {
          ...base,
          hint: ctx.auth
            ? "it belongs to someone else: pbx push <file> without --slug makes your own copy"
            : "run pbx login: anonymous scripts can only be edited with their claim token",
        },
      ];
    case "not_found":
      return [
        `${script} not found`,
        { ...base, hint: "check the slug (private scripts only show up for their owner)" },
      ];
    case "gone":
      return [`${script} was removed${serverMsg ? `: ${serverMsg}` : ""}`, base];
    case "version_conflict": {
      const latest = ctx.details.latestVersion;
      return [
        `remote moved on: ${ctx.slug ?? "script"} is at v${latest ?? "?"}${ctx.baseVersion ? `, you're based on v${ctx.baseVersion}` : ""}`,
        { ...base, hint: `pbx pull ${ctx.slug ?? "<slug>"} --force to catch up, or pbx push --force to overwrite` },
      ];
    }
    case "payload_too_large":
      return [`script is over the ${formatBytes(MAX_SCRIPT_BYTES)} limit`, { ...base, hint: "split it into modules" }];
    case "validation_failed": {
      const issues = (ctx.details.issues as { path: string; message: string }[] | undefined) ?? [];
      const detail = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
      return [`the server rejected that${detail ? `: ${detail}` : ""}`, { ...base, hint: serverMsg || undefined }];
    }
    case "invalid_content":
      return [serverMsg || "the server rejected the script content", base];
    case "rate_limited": {
      const s = ctx.details.retryAfter;
      return [
        `rate limited${s ? `, retry in ${s}s` : ""}`,
        { ...base, hint: "slow down a little; pushes refill at 10/min" },
      ];
    }
    case "internal":
      return ["pasteblox had a moment (500)", { ...base, hint: "try again in a bit" }];
    default:
      return [serverMsg || code.replace(/_/g, " "), base];
  }
}

export function networkError(base: string, e: unknown): CliError {
  const err = e as { name?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = err.cause?.code ?? err.code;
  // node's fetch (undici) refuses WHATWG "bad ports" (1, 6000, 6665…) before connecting, with
  // only `cause.message === "bad port"`; bun connects and reports ConnectionRefused instead.
  if (err.cause?.message === "bad port") {
    let port = "that port";
    try {
      port = `port ${new URL(base).port}`;
    } catch {}
    return new CliError(`can't reach ${base} (${port} is blocked by fetch)`, {
      hint: "use a different port for --api / PASTEBLOX_API",
      code: "network",
    });
  }
  const what =
    err.name === "TimeoutError" || err.name === "AbortError"
      ? "timed out"
      : code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? "dns lookup failed"
        : code === "ECONNREFUSED" || code === "ConnectionRefused"
          ? "connection refused"
          : code
            ? code.toLowerCase()
            : "network error";
  return new CliError(`can't reach ${base} (${what})`, {
    hint: "check your connection, or point pbx elsewhere with --api <url> / PASTEBLOX_API",
    code: "network",
  });
}
