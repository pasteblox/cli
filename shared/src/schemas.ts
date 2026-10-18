/**
 * Zod v4 contract for /api/v1.
 * Consumed by the web app (route handlers validate with these) and the pbx CLI (parses responses).
 * Runtime-agnostic: only `zod` and ./constants.
 */
import { z } from "zod";
import {
  DEFAULT_PAGE_SIZE,
  ERROR_CODES,
  EXPLORE_SORTS,
  HANDLE_FORMAT_ERROR,
  HANDLE_REGEX,
  HANDLE_RESERVED_ERROR,
  LANGUAGES,
  MAX_CLAIM_ITEMS,
  MAX_DESCRIPTION_LENGTH,
  MAX_GAME_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PAGE_SIZE,
  MAX_REPORT_DETAILS_LENGTH,
  MAX_SCRIPT_BYTES,
  MAX_TAGS,
  MAX_TITLE_LENGTH,
  PUSH_SOURCES,
  REPORT_REASONS,
  RESERVED_HANDLES,
  SAFETY_FLAG_CODES,
  SAFETY_SEVERITIES,
  SCRIPT_SORTS,
  SLUG_REGEX,
  TAG_REGEX,
  VISIBILITIES,
} from "./constants";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** UTF-8 byte length without TextEncoder/Buffer (works in every runtime, no allocation). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3; // lone surrogate → U+FFFD (3 bytes) when encoded
    } else bytes += 3;
  }
  return bytes;
}

/** Line count as shown in the viewer: number of "\n" + 1 (an empty file is 1 line). */
export function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export function isValidSlug(s: string): boolean {
  return SLUG_REGEX.test(s);
}

/** Parses "abc…" or "abc…@12" (the raw URL segment). Returns null if malformed. */
export function parseRawRef(segment: string): { slug: string; version: number | null } | null {
  const decoded = segment.includes("%") ? safeDecode(segment) : segment;
  if (decoded === null) return null;
  const lower = decoded.toLowerCase();
  const at = lower.indexOf("@");
  const slug = at === -1 ? lower : lower.slice(0, at);
  if (!SLUG_REGEX.test(slug)) return null;
  if (at === -1) return { slug, version: null };
  const v = parseVersionToken(lower.slice(at + 1));
  return v === null ? null : { slug, version: v };
}

/** Accepts "12" or "v12". */
export function parseVersionToken(token: string): number | null {
  const m = /^v?([1-9][0-9]{0,8})$/i.exec(token);
  return m ? Number(m[1]) : null;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function rawUrl(origin: string, slug: string, version?: number): string {
  return `${origin}/raw/${slug}${version ? `@${version}` : ""}`;
}

export function loadstringFor(url: string): string {
  return `loadstring(game:HttpGet("${url}"))()`;
}

/**
 * Body for raw 404/410/429 responses: valid Lua so `loadstring(...)()` raises a readable error
 * in the executor console instead of a parse error. Level 0 = no position prefix.
 */
export function luaErrorBody(message: string): string {
  const escaped = message
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // any line break (a lone \r too) would end the Lua string literal; other C0/C1 controls
    // are dropped so the body stays one clean line
    .replace(/\r\n?|\n/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars on purpose
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "");
  return `error("[pasteblox] ${escaped}", 0)\n`;
}

// ── Text hygiene ─────────────────────────────────────────────────────────────

/**
 * Characters never allowed in short user-visible text (titles, game names, version messages,
 * device names): C0/C1 controls (NUL breaks Postgres `text`), line/paragraph separators, and the
 * bidi embedding/override/isolate controls used for "Trojan Source"-style spoofing
 * (`evil\u202etxt.exe`). Plain LRM/RLM marks stay allowed for RTL text.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars on purpose
export const UNSAFE_LINE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** Multi-line text (descriptions, report details): like above but `\n`, `\r` and `\t` are fine. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars on purpose
export const UNSAFE_BLOCK_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** Trimmed single-line text of at most `max` chars with no control or bidi-override characters. */
export function lineText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .refine((s) => !UNSAFE_LINE_CHARS.test(s), {
      error: "contains control or bidi-override characters",
    });
}

/** Trimmed multi-line text of at most `max` chars (newlines and tabs allowed). */
export function blockText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .refine((s) => !UNSAFE_BLOCK_CHARS.test(s), {
      error: "contains control or bidi-override characters",
    });
}

// ── Primitives ───────────────────────────────────────────────────────────────

export const SlugSchema = z.string().regex(SLUG_REGEX, { error: "invalid slug" });
export const VersionNumberSchema = z.int().min(1);
export const VisibilitySchema = z.enum(VISIBILITIES);
export const LanguageSchema = z.enum(LANGUAGES);
export const PushSourceSchema = z.enum(PUSH_SOURCES);
export const ReportReasonSchema = z.enum(REPORT_REASONS);
export const SafetyFlagCodeSchema = z.enum(SAFETY_FLAG_CODES);
export const ScriptSortSchema = z.enum(SCRIPT_SORTS);
export const ExploreSortSchema = z.enum(EXPLORE_SORTS);
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export const DateTimeSchema = z.iso.datetime({ offset: true });

export const ScriptContentSchema = z
  .string()
  .refine((s) => utf8ByteLength(s) <= MAX_SCRIPT_BYTES, {
    error: `script exceeds ${MAX_SCRIPT_BYTES} bytes`,
  })
  .refine((s) => !s.includes("\u0000"), { error: "script contains NUL bytes" })
  .refine((s) => s.trim().length > 0, { error: "script is empty" });

export const TitleSchema = lineText(MAX_TITLE_LENGTH);
export const DescriptionSchema = blockText(MAX_DESCRIPTION_LENGTH);
export const MessageSchema = lineText(MAX_MESSAGE_LENGTH);
/** a version's changelog: what changed, in detail (bullets, short paragraphs) */
export const NotesSchema = blockText(MAX_NOTES_LENGTH);
export const GameSchema = lineText(MAX_GAME_LENGTH).pipe(z.string().min(1));
export const TagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(TAG_REGEX, { error: "tags are 1–24 chars of a-z, 0-9, -" });
export const TagsSchema = z
  .array(TagSchema)
  .max(MAX_TAGS)
  .transform((tags) => [...new Set(tags)]);

export const HandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HANDLE_REGEX, { error: HANDLE_FORMAT_ERROR })
  .refine((h) => !(RESERVED_HANDLES as readonly string[]).includes(h), {
    error: HANDLE_RESERVED_ERROR,
  });

/** Opaque keyset cursor (sealed with AES-GCM, produced and parsed by the server only). */
export const CursorSchema = z.string().max(256);
export const LimitSchema = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE);

// ── Errors ───────────────────────────────────────────────────────────────────

/** Every non-2xx JSON response from /api/v1 has this body. (Raw routes return Lua instead.) */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    /** validation_failed: per-field issues */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /** rate_limited: seconds (also sent as Retry-After) */
    retryAfter: z.int().optional(),
    /** version_conflict: the server's latest version */
    latestVersion: z.int().optional(),
  }),
});

// ── Shared response objects ──────────────────────────────────────────────────

export const SafetyFlagSchema = z.object({
  code: SafetyFlagCodeSchema,
  severity: z.enum(SAFETY_SEVERITIES),
  line: z.int().optional(),
  count: z.int(),
  /** remote_loader / http_exfil: distinct hosts seen (max 10) */
  hosts: z.array(z.string()).optional(),
});

export const UserRefSchema = z.object({
  handle: z.string(),
  name: z.string(),
  image: z.string().nullable(),
});

export const ScriptUrlsSchema = z.object({
  page: z.url(),
  /** stable latest raw URL (what people should share) */
  raw: z.url(),
  /** immutable raw URL for this response's version */
  rawPinned: z.url(),
  /** `loadstring(game:HttpGet("<raw>"))()` */
  loadstring: z.string(),
});

export const VersionMetaSchema = z.object({
  n: VersionNumberSchema,
  message: z.string(),
  /** detailed changelog ("" when none); older servers omit it */
  notes: z.string().default(""),
  sizeBytes: z.int(),
  lineCount: z.int(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  flags: z.array(SafetyFlagSchema),
  source: PushSourceSchema,
  author: UserRefSchema.nullable(),
  createdAt: DateTimeSchema,
});

export const VersionWithContentSchema = VersionMetaSchema.extend({ content: z.string() });

/**
 * Set when the script's code is hosted for a partner site (rscripts.net). `creatorName` is the
 * partner's display name for the author (plain text) and is only meaningful while the script is
 * not yet transferred; `url` is the script's page on the partner site (https, host-checked).
 */
export const HostedForSchema = z.object({
  partner: z.string(),
  /** partner display name, e.g. "rscripts.net" */
  name: z.string(),
  creatorName: z.string().nullable(),
  url: z.url().nullable(),
  /** the creator moved it to their own pasteblox account */
  transferred: z.boolean(),
});

export const ScriptSummarySchema = z.object({
  slug: SlugSchema,
  title: z.string(),
  description: z.string(),
  visibility: VisibilitySchema,
  language: LanguageSchema,
  game: z.string().nullable(),
  tags: z.array(z.string()),
  latestVersion: VersionNumberSchema,
  lineCount: z.int(),
  sizeBytes: z.int(),
  starCount: z.int(),
  forkCount: z.int(),
  viewCount: z.int(),
  /** raw fetches; only returned to the owner, 0 for everyone else */
  fetchCount: z.int(),
  flags: z.array(SafetyFlagCodeSchema),
  owner: UserRefSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
  publishedAt: DateTimeSchema.nullable(),
  /** partner-hosted scripts only (absent / null for everything else) */
  hostedFor: HostedForSchema.nullable().optional(),
});

export const ScriptDetailSchema = ScriptSummarySchema.extend({
  forkedFrom: z.object({ slug: SlugSchema, version: VersionNumberSchema }).nullable(),
  viewer: z.object({
    canEdit: z.boolean(),
    /** null when anonymous */
    starred: z.boolean().nullable(),
  }),
  urls: ScriptUrlsSchema,
});

export const PageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: CursorSchema.nullable() });

// ── POST /api/v1/scripts ─────────────────────────────────────────────────────

export const CreateScriptRequestSchema = z.object({
  content: ScriptContentSchema,
  title: TitleSchema.optional(),
  description: DescriptionSchema.optional(),
  language: LanguageSchema.default("luau"),
  /** anonymous callers may only use "unlisted" (server returns 403 otherwise) */
  visibility: VisibilitySchema.default("unlisted"),
  game: GameSchema.nullish(),
  tags: TagsSchema.optional(),
  message: MessageSchema.optional(),
  notes: NotesSchema.optional(),
});

export const CreateScriptResponseSchema = z.object({
  script: ScriptDetailSchema,
  version: VersionMetaSchema,
  /**
   * Anonymous creates only, returned exactly once. Grants push/update/delete via
   * `x-claim-token` until the script is claimed. The web stores it in the pbx_claims cookie.
   */
  claimToken: z.string().optional(),
});

// ── GET /api/v1/scripts/:slug ────────────────────────────────────────────────

export const GetScriptQuerySchema = z.object({
  /** how many recent versions to embed (0–100) */
  versions: z.coerce.number().int().min(0).max(100).default(20),
});
export const GetScriptResponseSchema = z.object({
  script: ScriptDetailSchema,
  versions: z.array(VersionMetaSchema),
});

// ── PATCH /api/v1/scripts/:slug ──────────────────────────────────────────────

export const UpdateScriptRequestSchema = z
  .object({
    title: TitleSchema,
    description: DescriptionSchema,
    visibility: VisibilitySchema,
    language: LanguageSchema,
    game: GameSchema.nullable(),
    tags: TagsSchema,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { error: "nothing to update" });
export const UpdateScriptResponseSchema = z.object({ script: ScriptDetailSchema });

// ── DELETE /api/v1/scripts/:slug ─────────────────────────────────────────────

export const DeleteScriptResponseSchema = z.object({
  ok: z.literal(true),
  /** soft-deleted; hard purge after this instant */
  purgeAfter: DateTimeSchema,
});

// ── POST /api/v1/scripts/:slug/versions ──────────────────────────────────────

export const PushVersionRequestSchema = z.object({
  content: ScriptContentSchema,
  message: MessageSchema.optional(),
  notes: NotesSchema.optional(),
  /** optimistic concurrency: if set and ≠ latest, 409 version_conflict */
  baseVersion: VersionNumberSchema.optional(),
});
export const PushVersionResponseSchema = z.object({
  /** true when content equals the latest version (no new version created) */
  unchanged: z.boolean(),
  version: VersionMetaSchema,
  urls: ScriptUrlsSchema,
});

// ── PATCH /api/v1/scripts/:slug/versions/:n ─────────────────────────────────

/** Rewrite a version's summary and/or changelog (the code never changes). */
export const UpdateVersionRequestSchema = z
  .object({ message: MessageSchema, notes: NotesSchema })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { error: "nothing to update" });
export const UpdateVersionResponseSchema = z.object({
  version: VersionMetaSchema,
});

// ── GET /api/v1/scripts/:slug/versions[/:n] ──────────────────────────────────

export const ListVersionsQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: LimitSchema,
});
export const ListVersionsResponseSchema = PageSchema(VersionMetaSchema);
export const GetVersionResponseSchema = z.object({ version: VersionWithContentSchema });

// ── GET /api/v1/me/scripts ───────────────────────────────────────────────────

export const ListMyScriptsQuerySchema = z.object({
  q: lineText(100).optional(),
  visibility: VisibilitySchema.optional(),
  sort: ScriptSortSchema.default("updated"),
  cursor: CursorSchema.optional(),
  limit: LimitSchema,
});
export const ListScriptsResponseSchema = PageSchema(ScriptSummarySchema);

// ── Explore (web uses the same shape for /explore search params) ─────────────

export const ExploreQuerySchema = z.object({
  sort: ExploreSortSchema.default("trending"),
  tag: TagSchema.optional(),
  game: lineText(MAX_GAME_LENGTH).pipe(z.string().toLowerCase()).optional(),
  cursor: CursorSchema.optional(),
});

// ── PUT/DELETE /api/v1/scripts/:slug/star ────────────────────────────────────

export const StarResponseSchema = z.object({ starred: z.boolean(), starCount: z.int() });

// ── POST /api/v1/scripts/:slug/fork ──────────────────────────────────────────

export const ForkScriptRequestSchema = z.object({
  /** defaults to the latest version */
  version: VersionNumberSchema.optional(),
  title: TitleSchema.optional(),
  visibility: VisibilitySchema.default("unlisted"),
});
export const ForkScriptResponseSchema = CreateScriptResponseSchema.omit({ claimToken: true });

// ── POST /api/v1/scripts/:slug/reports ───────────────────────────────────────

export const ReportRequestSchema = z.object({
  reason: ReportReasonSchema,
  details: blockText(MAX_REPORT_DETAILS_LENGTH).default(""),
  version: VersionNumberSchema.optional(),
});
/** Always 202, also for duplicates (no oracle for "already reported"). */
export const ReportResponseSchema = z.object({ ok: z.literal(true) });

// ── GET /api/v1/me (whoami) ──────────────────────────────────────────────────

export const AuthMethodSchema = z.enum(["session", "bearer", "api_key"]);
export const WhoamiResponseSchema = z.object({
  user: UserRefSchema.extend({ role: z.enum(["user", "admin"]) }),
  auth: z.object({
    method: AuthMethodSchema,
    /** api_key only */
    keyId: z.string().optional(),
    keyName: z.string().nullable().optional(),
  }),
});

// ── POST /api/v1/claim ───────────────────────────────────────────────────────

export const ClaimRequestSchema = z.object({
  items: z
    .array(z.object({ slug: SlugSchema, token: z.string().min(16).max(128) }))
    .min(1)
    .max(MAX_CLAIM_ITEMS),
});
export const ClaimResponseSchema = z.object({
  claimed: z.array(SlugSchema),
  /** same reason for wrong token / already claimed / missing: no oracle */
  failed: z.array(SlugSchema),
});

// ── POST /api/v1/cli/exchange ────────────────────────────────────────────────

export const CliExchangeRequestSchema = z.object({
  /** shown in /dashboard → CLI devices, e.g. "jan-mbp" */
  deviceName: lineText(64).pipe(z.string().min(1)),
  platform: lineText(32).optional(),
  cliVersion: lineText(32).optional(),
});
export const CliExchangeResponseSchema = z.object({
  /** plaintext API key, returned once; the CLI stores it (0600) */
  apiKey: z.string(),
  keyId: z.string(),
  user: UserRefSchema,
});

// ── DELETE /api/v1/cli/key (added for `pbx logout`) ──────────────────────────

/**
 * Revokes the API key that authenticated this request (`x-api-key` only).
 * better-auth's own `/api/auth/api-key/delete` needs a session, which a CLI that only
 * holds a key (enableSessionForAPIKeys: false) does not have. Idempotent from the CLI's view:
 * a key that is already gone gets 401, which `pbx logout` treats as success.
 */
export const CliRevokeResponseSchema = z.object({ ok: z.literal(true), keyId: z.string() });

// ── better-auth device authorization (/api/auth/device/*, RFC 8628) ─────────
// Not /api/v1 (better-auth owns these routes), but the CLI parses them, so the shapes live here
// (from better-auth 1.7.7 dist/plugins/device-authorization/routes.mjs).

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export const DeviceCodeRequestSchema = z.object({
  client_id: z.string(),
  scope: z.string().optional(),
});
export const DeviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  /** seconds */
  expires_in: z.number(),
  /** seconds between polls */
  interval: z.number().optional(),
});
export const DeviceTokenRequestSchema = z.object({
  grant_type: z.literal(DEVICE_GRANT_TYPE),
  device_code: z.string(),
  client_id: z.string(),
});
export const DeviceTokenResponseSchema = z.object({
  /** a raw better-auth session token: send as `Authorization: Bearer` to /api/v1/cli/exchange */
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});
export const DEVICE_TOKEN_ERRORS = [
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
  "invalid_grant",
  "invalid_request",
] as const;
/** 400 body from /device/token. `error` is kept open (string) so unknown codes don't fail parsing. */
export const DeviceTokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

// ── Inferred types ───────────────────────────────────────────────────────────

export type Visibility = z.infer<typeof VisibilitySchema>;
export type Language = z.infer<typeof LanguageSchema>;
export type PushSource = z.infer<typeof PushSourceSchema>;
export type ReportReason = z.infer<typeof ReportReasonSchema>;
export type SafetyFlagCode = z.infer<typeof SafetyFlagCodeSchema>;
export type SafetyFlag = z.infer<typeof SafetyFlagSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type UserRef = z.infer<typeof UserRefSchema>;
export type ScriptUrls = z.infer<typeof ScriptUrlsSchema>;
export type VersionMeta = z.infer<typeof VersionMetaSchema>;
export type VersionWithContent = z.infer<typeof VersionWithContentSchema>;
export type ScriptSummary = z.infer<typeof ScriptSummarySchema>;
export type ScriptDetail = z.infer<typeof ScriptDetailSchema>;
export type CreateScriptRequest = z.input<typeof CreateScriptRequestSchema>;
export type CreateScriptResponse = z.infer<typeof CreateScriptResponseSchema>;
export type GetScriptResponse = z.infer<typeof GetScriptResponseSchema>;
export type UpdateScriptRequest = z.input<typeof UpdateScriptRequestSchema>;
export type UpdateScriptResponse = z.infer<typeof UpdateScriptResponseSchema>;
export type DeleteScriptResponse = z.infer<typeof DeleteScriptResponseSchema>;
export type PushVersionRequest = z.input<typeof PushVersionRequestSchema>;
export type PushVersionResponse = z.infer<typeof PushVersionResponseSchema>;
export type UpdateVersionRequest = z.input<typeof UpdateVersionRequestSchema>;
export type UpdateVersionResponse = z.infer<typeof UpdateVersionResponseSchema>;
export type ListVersionsResponse = z.infer<typeof ListVersionsResponseSchema>;
export type GetVersionResponse = z.infer<typeof GetVersionResponseSchema>;
export type ListMyScriptsQuery = z.input<typeof ListMyScriptsQuerySchema>;
export type ListScriptsResponse = z.infer<typeof ListScriptsResponseSchema>;
export type ExploreQuery = z.infer<typeof ExploreQuerySchema>;
export type StarResponse = z.infer<typeof StarResponseSchema>;
export type ForkScriptRequest = z.input<typeof ForkScriptRequestSchema>;
export type ForkScriptResponse = z.infer<typeof ForkScriptResponseSchema>;
export type ReportRequest = z.input<typeof ReportRequestSchema>;
export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>;
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;
export type CliExchangeRequest = z.infer<typeof CliExchangeRequestSchema>;
export type CliExchangeResponse = z.infer<typeof CliExchangeResponseSchema>;
export type CliRevokeResponse = z.infer<typeof CliRevokeResponseSchema>;
export type HostedFor = z.infer<typeof HostedForSchema>;
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;
export type DeviceTokenError = z.infer<typeof DeviceTokenErrorSchema>;

// ── Endpoint registry (single source for the CLI client and route tests) ────

export type AuthMode = "anon" | "claim" | "session" | "bearer" | "api_key";

export const API_ENDPOINTS = {
  createScript: {
    method: "POST",
    path: "/scripts",
    auth: ["anon", "session", "bearer", "api_key"],
    request: CreateScriptRequestSchema,
    response: CreateScriptResponseSchema,
  },
  getScript: {
    method: "GET",
    path: "/scripts/:slug",
    auth: ["anon", "claim", "session", "bearer", "api_key"],
    query: GetScriptQuerySchema,
    response: GetScriptResponseSchema,
  },
  updateScript: {
    method: "PATCH",
    path: "/scripts/:slug",
    auth: ["claim", "session", "bearer", "api_key"],
    request: UpdateScriptRequestSchema,
    response: UpdateScriptResponseSchema,
  },
  deleteScript: {
    method: "DELETE",
    path: "/scripts/:slug",
    auth: ["claim", "session", "bearer", "api_key"],
    response: DeleteScriptResponseSchema,
  },
  /** undo a soft delete within DELETE_GRACE_DAYS (owner/admin); 410 gone after the window */
  restoreScript: {
    method: "POST",
    path: "/scripts/:slug/restore",
    auth: ["bearer", "api_key"],
    response: UpdateScriptResponseSchema,
  },
  pushVersion: {
    method: "POST",
    path: "/scripts/:slug/versions",
    auth: ["claim", "session", "bearer", "api_key"],
    request: PushVersionRequestSchema,
    response: PushVersionResponseSchema,
  },
  updateVersion: {
    method: "PATCH",
    path: "/scripts/:slug/versions/:n",
    auth: ["claim", "session", "bearer", "api_key"],
    request: UpdateVersionRequestSchema,
    response: UpdateVersionResponseSchema,
  },
  listVersions: {
    method: "GET",
    path: "/scripts/:slug/versions",
    auth: ["anon", "claim", "session", "bearer", "api_key"],
    query: ListVersionsQuerySchema,
    response: ListVersionsResponseSchema,
  },
  getVersion: {
    method: "GET",
    path: "/scripts/:slug/versions/:n",
    auth: ["anon", "claim", "session", "bearer", "api_key"],
    response: GetVersionResponseSchema,
  },
  getVersionRaw: {
    method: "GET",
    path: "/scripts/:slug/versions/:n/raw",
    auth: ["anon", "claim", "session", "bearer", "api_key"],
    response: null,
  },
  listMyScripts: {
    method: "GET",
    path: "/me/scripts",
    auth: ["session", "bearer", "api_key"],
    query: ListMyScriptsQuerySchema,
    response: ListScriptsResponseSchema,
  },
  star: {
    method: "PUT",
    path: "/scripts/:slug/star",
    auth: ["session", "bearer", "api_key"],
    response: StarResponseSchema,
  },
  unstar: {
    method: "DELETE",
    path: "/scripts/:slug/star",
    auth: ["session", "bearer", "api_key"],
    response: StarResponseSchema,
  },
  fork: {
    method: "POST",
    path: "/scripts/:slug/fork",
    auth: ["session", "bearer", "api_key"],
    request: ForkScriptRequestSchema,
    response: ForkScriptResponseSchema,
  },
  report: {
    method: "POST",
    path: "/scripts/:slug/reports",
    auth: ["anon", "session", "bearer", "api_key"],
    request: ReportRequestSchema,
    response: ReportResponseSchema,
  },
  whoami: { method: "GET", path: "/me", auth: ["session", "bearer", "api_key"], response: WhoamiResponseSchema },
  claim: {
    method: "POST",
    path: "/claim",
    auth: ["session", "bearer", "api_key"],
    request: ClaimRequestSchema,
    response: ClaimResponseSchema,
  },
  cliExchange: {
    method: "POST",
    path: "/cli/exchange",
    auth: ["bearer"],
    request: CliExchangeRequestSchema,
    response: CliExchangeResponseSchema,
  },
  cliRevoke: { method: "DELETE", path: "/cli/key", auth: ["api_key"], response: CliRevokeResponseSchema },
} as const satisfies Record<
  string,
  {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    auth: readonly AuthMode[];
    request?: z.ZodType;
    query?: z.ZodType;
    response: z.ZodType | null;
  }
>;
