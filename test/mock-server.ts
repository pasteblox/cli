/**
 * Contract mock of the pasteblox API for CLI tests (Bun.serve).
 *
 * Every request body is validated with the shared request schema and every JSON response is
 * validated with the shared response schema before it is sent; a response that doesn't match the
 * contract becomes a 500 and is recorded in `contractErrors`, so a passing CLI test also means the
 * mock (and therefore the CLI's expectations) match @pasteblox/shared.
 *
 * Run standalone for manual poking: `bun test/mock-server.ts` (prints the url).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  API_BASE_PATH,
  ApiErrorSchema,
  CLI_CLIENT_ID,
  ClaimRequestSchema,
  ClaimResponseSchema,
  CliExchangeRequestSchema,
  CliExchangeResponseSchema,
  CliRevokeResponseSchema,
  CreateScriptRequestSchema,
  CreateScriptResponseSchema,
  countLines,
  DeleteScriptResponseSchema,
  DeviceCodeRequestSchema,
  DeviceCodeResponseSchema,
  DeviceTokenErrorSchema,
  DeviceTokenRequestSchema,
  DeviceTokenResponseSchema,
  type ErrorCode,
  GetScriptQuerySchema,
  GetScriptResponseSchema,
  GetVersionResponseSchema,
  HEADER_API_KEY,
  HEADER_CLAIM_TOKEN,
  type Language,
  ListMyScriptsQuerySchema,
  ListScriptsResponseSchema,
  ListVersionsQuerySchema,
  ListVersionsResponseSchema,
  loadstringFor,
  PushVersionRequestSchema,
  PushVersionResponseSchema,
  rawUrl,
  type SafetyFlag,
  SLUG_ALPHABET,
  SLUG_REGEX,
  UpdateScriptRequestSchema,
  UpdateScriptResponseSchema,
  UpdateVersionRequestSchema,
  UpdateVersionResponseSchema,
  utf8ByteLength,
  type Visibility,
  WhoamiResponseSchema,
} from "@pasteblox/shared";
import type { z } from "zod";

// ── state ────────────────────────────────────────────────────────────────────

interface User {
  id: string;
  handle: string;
  name: string;
}

interface Version {
  n: number;
  content: string;
  message: string;
  notes: string;
  sha256: string;
  sizeBytes: number;
  lineCount: number;
  flags: SafetyFlag[];
  authorId: string | null;
  createdAt: string;
}

export interface MockScript {
  slug: string;
  title: string;
  description: string;
  visibility: Visibility;
  language: Language;
  ownerId: string | null;
  claimToken: string | null;
  versions: Version[];
  viewCount: number;
  fetchCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  polls: number;
  expiresAt: number;
}

export interface MockOptions {
  /** polls answered with authorization_pending before the outcome */
  pendingPolls?: number;
  deviceOutcome?: "approve" | "deny" | "expire";
  /** device poll interval in seconds (better-auth default is 5; tests use 0) */
  interval?: number;
  user?: User;
}

export interface RequestLog {
  method: string;
  path: string;
  apiKey: string | null;
  bearer: string | null;
  claimToken: string | null;
  body: unknown;
}

export interface MockServer {
  url: string;
  scripts: Map<string, MockScript>;
  keys: Map<string, { keyId: string; userId: string; name: string }>;
  requests: RequestLog[];
  contractErrors: string[];
  options: Required<MockOptions>;
  /** next `count` write requests (POST/PATCH/DELETE under /api/v1) get 429 */
  rateLimit(count: number, retryAfter?: number): void;
  /** register an API key for PASTEBLOX_TOKEN-style tests */
  addKey(key: string, name?: string): void;
  stop(): void;
}

const iso = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function newSlug(): string {
  let s = "";
  const bytes = randomBytes(32);
  for (const b of bytes) {
    if (b >= 248) continue;
    s += SLUG_ALPHABET[b % 31];
    if (s.length === 10) break;
  }
  return s.length === 10 ? s : newSlug();
}

function scan(content: string): SafetyFlag[] {
  const flags: SafetyFlag[] = [];
  const lines = content.split("\n");
  const hook = lines.findIndex((l) => /discord(?:app)?\.com\/api\/webhooks\//.test(l));
  if (hook !== -1) flags.push({ code: "discord_webhook", severity: "high", line: hook + 1, count: 1 });
  const loader = lines.findIndex((l) => /loadstring\s*\(\s*game\s*:\s*HttpGet/.test(l));
  if (loader !== -1) flags.push({ code: "remote_loader", severity: "info", line: loader + 1, count: 1 });
  return flags;
}

// ── server ───────────────────────────────────────────────────────────────────

export function startMockServer(opts: MockOptions = {}): MockServer {
  const options: Required<MockOptions> = {
    pendingPolls: opts.pendingPolls ?? 2,
    deviceOutcome: opts.deviceOutcome ?? "approve",
    interval: opts.interval ?? 0,
    user: opts.user ?? { id: "u_jan", handle: "jan", name: "Jan" },
  };
  const users = new Map<string, User>([[options.user.id, options.user]]);
  const scripts = new Map<string, MockScript>();
  const keys = new Map<string, { keyId: string; userId: string; name: string }>();
  const sessions = new Map<string, string>();
  const devices = new Map<string, DeviceCode>();
  const requests: RequestLog[] = [];
  const contractErrors: string[] = [];
  let rateLimited = 0;
  let retryAfter = 7;
  let origin = "";

  const json = <S extends z.ZodType>(schema: S, body: z.input<S>, status = 200): Response => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const msg = `response for status ${status} violates contract: ${JSON.stringify(parsed.error.issues)}`;
      contractErrors.push(msg);
      return Response.json({ error: { code: "internal", message: msg } }, { status: 500 });
    }
    return Response.json(body, { status });
  };
  const error = (
    status: number,
    code: ErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
    headers?: Record<string, string>,
  ) =>
    new Response(JSON.stringify(ApiErrorSchema.parse({ error: { code, message, ...extra } })), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const userRef = (id: string | null) => {
    if (!id) return null;
    const u = users.get(id);
    return u ? { handle: u.handle, name: u.name, image: null } : null;
  };

  const urls = (s: MockScript, n: number) => ({
    page: `${origin}/s/${s.slug}`,
    raw: rawUrl(origin, s.slug),
    rawPinned: rawUrl(origin, s.slug, n),
    loadstring: loadstringFor(rawUrl(origin, s.slug)),
  });

  const versionMeta = (v: Version) => ({
    n: v.n,
    message: v.message,
    notes: v.notes,
    sizeBytes: v.sizeBytes,
    lineCount: v.lineCount,
    sha256: v.sha256,
    flags: v.flags,
    source: "cli" as const,
    author: userRef(v.authorId),
    createdAt: v.createdAt,
  });

  const latest = (s: MockScript) => s.versions[s.versions.length - 1] as Version;

  const summary = (s: MockScript, viewerId: string | null) => {
    const l = latest(s);
    return {
      slug: s.slug,
      title: s.title,
      description: s.description,
      visibility: s.visibility,
      language: s.language,
      game: null,
      tags: [],
      latestVersion: l.n,
      lineCount: l.lineCount,
      sizeBytes: l.sizeBytes,
      starCount: 0,
      forkCount: 0,
      viewCount: s.viewCount,
      fetchCount: viewerId && viewerId === s.ownerId ? s.fetchCount : 0,
      flags: [...new Set(l.flags.map((f) => f.code))],
      owner: userRef(s.ownerId),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      publishedAt: s.visibility === "public" ? s.createdAt : null,
    };
  };

  const detail = (s: MockScript, viewerId: string | null, canEdit: boolean) => ({
    ...summary(s, viewerId),
    forkedFrom: null,
    viewer: { canEdit, starred: viewerId ? false : null },
    urls: urls(s, latest(s).n),
  });

  const makeVersion = (
    n: number,
    content: string,
    message: string,
    notes: string,
    authorId: string | null,
  ): Version => ({
    n,
    content,
    message,
    notes,
    sha256: sha(content),
    sizeBytes: utf8ByteLength(content),
    lineCount: countLines(content),
    flags: scan(content),
    authorId,
    createdAt: iso(),
  });

  async function readBody(req: Request): Promise<unknown> {
    const text = await req.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return Symbol.for("invalid-json");
    }
  }

  function validate<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> | Response {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    return error(422, "validation_failed", "invalid request", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      const apiKey = req.headers.get(HEADER_API_KEY);
      const auth = req.headers.get("authorization");
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      const claimToken = req.headers.get(HEADER_CLAIM_TOKEN);
      requests.push({ method, path, apiKey, bearer, claimToken, body });
      if (body === Symbol.for("invalid-json")) return error(400, "bad_request", "body is not JSON");

      // ── better-auth device flow ──────────────────────────────────────────
      if (path === "/api/auth/device/code" && method === "POST") {
        const v = validate(DeviceCodeRequestSchema, body);
        if (v instanceof Response) return v;
        if (v.client_id !== CLI_CLIENT_ID) return Response.json({ error: "invalid_client" }, { status: 400 });
        const userCode = randomBytes(4).toString("hex").toUpperCase();
        const deviceCode = randomBytes(20).toString("hex");
        devices.set(deviceCode, { deviceCode, userCode, polls: 0, expiresAt: Date.now() + 15 * 60_000 });
        return json(DeviceCodeResponseSchema, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${origin}/device`,
          verification_uri_complete: `${origin}/device?user_code=${userCode}`,
          expires_in: 900,
          interval: options.interval,
        });
      }
      if (path === "/api/auth/device/token" && method === "POST") {
        const v = validate(DeviceTokenRequestSchema, body);
        if (v instanceof Response) return v;
        const dc = devices.get(v.device_code);
        const tokenError = (e: string, d: string) =>
          new Response(JSON.stringify(DeviceTokenErrorSchema.parse({ error: e, error_description: d })), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        if (!dc) return tokenError("invalid_grant", "unknown device code");
        dc.polls++;
        if (dc.polls <= options.pendingPolls) return tokenError("authorization_pending", "waiting for approval");
        if (options.deviceOutcome === "deny") return tokenError("access_denied", "the user denied the request");
        if (options.deviceOutcome === "expire") return tokenError("expired_token", "the device code expired");
        devices.delete(v.device_code);
        const token = randomBytes(24).toString("base64url");
        sessions.set(token, options.user.id);
        return json(DeviceTokenResponseSchema, {
          access_token: token,
          token_type: "Bearer",
          expires_in: 604800,
          scope: "",
        });
      }

      if (!path.startsWith(API_BASE_PATH)) return new Response("not found", { status: 404 });
      const p = path.slice(API_BASE_PATH.length);

      // ── actor ───────────────────────────────────────────────────────────
      let userId: string | null = null;
      let keyId: string | null = null;
      if (apiKey) {
        const k = keys.get(apiKey);
        if (!k) return error(401, "unauthorized", "invalid api key");
        userId = k.userId;
        keyId = k.keyId;
      } else if (bearer) {
        const s = sessions.get(bearer);
        if (!s) return error(401, "unauthorized", "invalid session");
        userId = s;
      }

      if (method !== "GET" && rateLimited > 0) {
        rateLimited--;
        return error(429, "rate_limited", "slow down", { retryAfter }, { "retry-after": String(retryAfter) });
      }

      // ── cli key lifecycle ────────────────────────────────────────────────
      if (p === "/cli/exchange" && method === "POST") {
        if (!bearer || !userId || apiKey) return error(401, "unauthorized", "bearer session required");
        const v = validate(CliExchangeRequestSchema, body);
        if (v instanceof Response) return v;
        const key = `pbx_${randomBytes(24).toString("base64url")}`;
        const id = `key_${randomBytes(6).toString("hex")}`;
        keys.set(key, { keyId: id, userId, name: `pbx on ${v.deviceName}` });
        sessions.delete(bearer); // revoke the device session
        return json(CliExchangeResponseSchema, { apiKey: key, keyId: id, user: userRef(userId) as never });
      }
      if (p === "/cli/key" && method === "DELETE") {
        if (!apiKey || !keyId) return error(401, "unauthorized", "api key required");
        keys.delete(apiKey);
        return json(CliRevokeResponseSchema, { ok: true, keyId });
      }
      if (p === "/me" && method === "GET") {
        if (!userId) return error(401, "unauthorized", "sign in");
        const u = users.get(userId) as User;
        const k = apiKey ? keys.get(apiKey) : undefined;
        return json(WhoamiResponseSchema, {
          user: { handle: u.handle, name: u.name, image: null, role: "user" },
          auth: apiKey
            ? { method: "api_key", keyId: keyId ?? undefined, keyName: k?.name ?? null }
            : { method: "bearer" },
        });
      }
      if (p === "/me/scripts" && method === "GET") {
        if (!userId) return error(401, "unauthorized", "sign in");
        const q = validate(ListMyScriptsQuerySchema, Object.fromEntries(url.searchParams));
        if (q instanceof Response) return q;
        let mine = [...scripts.values()].filter((s) => s.ownerId === userId && !s.deletedAt);
        if (q.visibility) mine = mine.filter((s) => s.visibility === q.visibility);
        mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const start = q.cursor ? Number(Buffer.from(q.cursor, "base64url").toString()) : 0;
        const page = mine.slice(start, start + q.limit);
        const next = start + q.limit < mine.length ? Buffer.from(String(start + q.limit)).toString("base64url") : null;
        return json(ListScriptsResponseSchema, { items: page.map((s) => summary(s, userId)), nextCursor: next });
      }
      if (p === "/claim" && method === "POST") {
        if (!userId) return error(401, "unauthorized", "sign in");
        const v = validate(ClaimRequestSchema, body);
        if (v instanceof Response) return v;
        const claimed: string[] = [];
        const failed: string[] = [];
        for (const item of v.items) {
          const s = scripts.get(item.slug);
          if (s && !s.ownerId && s.claimToken === item.token && !s.deletedAt) {
            s.ownerId = userId;
            s.claimToken = null;
            claimed.push(item.slug);
          } else failed.push(item.slug);
        }
        return json(ClaimResponseSchema, { claimed, failed });
      }

      // ── scripts ──────────────────────────────────────────────────────────
      if (p === "/scripts" && method === "POST") {
        const v = validate(CreateScriptRequestSchema, body);
        if (v instanceof Response) return v;
        if (!userId && v.visibility !== "unlisted")
          return error(403, "forbidden", "anonymous scripts must be unlisted");
        const slug = newSlug();
        const token = userId ? null : randomBytes(32).toString("base64url");
        const now = iso();
        const s: MockScript = {
          slug,
          title: v.title ?? "",
          description: v.description ?? "",
          visibility: v.visibility,
          language: v.language,
          ownerId: userId,
          claimToken: token,
          versions: [makeVersion(1, v.content, v.message ?? "", v.notes ?? "", userId)],
          viewCount: 0,
          fetchCount: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        scripts.set(slug, s);
        return json(
          CreateScriptResponseSchema,
          {
            script: detail(s, userId, true),
            version: versionMeta(latest(s)),
            ...(token ? { claimToken: token } : {}),
          },
          201,
        );
      }

      const m = /^\/scripts\/([^/]+)(\/versions(?:\/([^/]+))?)?$/.exec(p);
      if (!m) return error(404, "not_found", `no route ${method} ${p}`);
      const slug = (m[1] as string).toLowerCase();
      if (!SLUG_REGEX.test(slug)) return error(404, "not_found", "script not found");
      const s = scripts.get(slug);
      const isOwner = Boolean(s && userId && s.ownerId === userId);
      const isClaimer = Boolean(s && !s.ownerId && !userId && claimToken && s.claimToken === claimToken);
      const canEdit = isOwner || isClaimer;
      if (!s || s.deletedAt || (s.visibility === "private" && !isOwner))
        return error(404, "not_found", "script not found");

      if (!m[2]) {
        if (method === "GET") {
          const q = validate(GetScriptQuerySchema, Object.fromEntries(url.searchParams));
          if (q instanceof Response) return q;
          const versions = [...s.versions].reverse().slice(0, q.versions).map(versionMeta);
          return json(GetScriptResponseSchema, { script: detail(s, userId, canEdit), versions });
        }
        if (!canEdit) return error(userId ? 403 : 401, userId ? "forbidden" : "unauthorized", "not yours");
        if (method === "PATCH") {
          const v = validate(UpdateScriptRequestSchema, body);
          if (v instanceof Response) return v;
          if (isClaimer && v.visibility && v.visibility !== "unlisted") {
            return error(403, "forbidden", "anonymous scripts must stay unlisted");
          }
          if (v.title !== undefined) s.title = v.title;
          if (v.visibility) s.visibility = v.visibility;
          if (v.description !== undefined) s.description = v.description;
          s.updatedAt = iso();
          return json(UpdateScriptResponseSchema, { script: detail(s, userId, canEdit) });
        }
        if (method === "DELETE") {
          s.deletedAt = iso();
          return json(DeleteScriptResponseSchema, {
            ok: true,
            purgeAfter: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          });
        }
        return error(404, "not_found", "no such route");
      }

      // /versions
      if (!m[3]) {
        if (method === "GET") {
          const q = validate(ListVersionsQuerySchema, Object.fromEntries(url.searchParams));
          if (q instanceof Response) return q;
          const all = [...s.versions].reverse();
          const start = q.cursor ? Number(Buffer.from(q.cursor, "base64url").toString()) : 0;
          const page = all.slice(start, start + q.limit);
          const next = start + q.limit < all.length ? Buffer.from(String(start + q.limit)).toString("base64url") : null;
          return json(ListVersionsResponseSchema, { items: page.map(versionMeta), nextCursor: next });
        }
        if (method === "POST") {
          if (!canEdit) return error(userId ? 403 : 401, userId ? "forbidden" : "unauthorized", "not yours");
          const v = validate(PushVersionRequestSchema, body);
          if (v instanceof Response) return v;
          const l = latest(s);
          if (v.baseVersion !== undefined && v.baseVersion !== l.n) {
            return error(409, "version_conflict", "base version is stale", { latestVersion: l.n });
          }
          if (sha(v.content) === l.sha256) {
            return json(PushVersionResponseSchema, { unchanged: true, version: versionMeta(l), urls: urls(s, l.n) });
          }
          const nv = makeVersion(l.n + 1, v.content, v.message ?? "", v.notes ?? "", userId);
          s.versions.push(nv);
          s.updatedAt = iso();
          return json(
            PushVersionResponseSchema,
            { unchanged: false, version: versionMeta(nv), urls: urls(s, nv.n) },
            201,
          );
        }
        return error(404, "not_found", "no such route");
      }

      // /versions/:n
      if (method === "PATCH") {
        if (!canEdit) return error(userId ? 403 : 401, userId ? "forbidden" : "unauthorized", "not yours");
        const u = validate(UpdateVersionRequestSchema, body);
        if (u instanceof Response) return u;
        const v = s.versions.find((x) => String(x.n) === m[3]);
        if (!v) return error(404, "not_found", `version ${m[3]} does not exist`);
        if (u.message !== undefined) v.message = u.message;
        if (u.notes !== undefined) v.notes = u.notes;
        return json(UpdateVersionResponseSchema, { version: versionMeta(v) });
      }
      if (method !== "GET") return error(404, "not_found", "no such route");
      const n = m[3] === "latest" ? latest(s).n : Number(m[3]);
      const v = s.versions.find((x) => x.n === n);
      if (!v) return error(404, "not_found", `version ${m[3]} does not exist (latest is ${latest(s).n})`);
      return json(GetVersionResponseSchema, { version: { ...versionMeta(v), content: v.content } });
    },
  });

  origin = `http://127.0.0.1:${server.port}`;
  return {
    url: origin,
    scripts,
    keys,
    requests,
    contractErrors,
    options,
    rateLimit(count, after = 7) {
      rateLimited = count;
      retryAfter = after;
    },
    addKey(key, name = "ci key") {
      keys.set(key, { keyId: `key_${randomBytes(6).toString("hex")}`, userId: options.user.id, name });
    },
    stop() {
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const mock = startMockServer({ interval: 1 });
  console.log(`pasteblox mock api on ${mock.url}`);
}
