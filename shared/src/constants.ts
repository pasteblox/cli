/**
 * Constants shared by the web app and the pbx CLI.
 * Runtime-agnostic: no Node, Bun, DOM or Next imports (CLI runs on Node ≥ 20 and Bun).
 */

// ── Slugs ────────────────────────────────────────────────────────────────────
/** Lowercase base32-ish without lookalikes (0 o 1 i l). 31 symbols. */
export const SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
/** 31^10 ≈ 8.2e14 (~49.5 bits). Same length for every visibility: slugs never change. */
export const SLUG_LENGTH = 10;
export const SLUG_REGEX = /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/;
/**
 * Seeded demo script owned by DEMO_HANDLE. `/s/[slug]` returns it from generateStaticParams
 * (cacheComponents needs at least one param) and the seed script always (re)creates it.
 */
export const DEMO_SLUG = "start2here";
/** Seeded official account; also the `/u/[handle]` generateStaticParams entry. Reserved below. */
export const DEMO_HANDLE = "pasteblox";

// ── Limits ───────────────────────────────────────────────────────────────────
/** Max UTF-8 bytes per version. Mirrored by the DB check `script_versions_size_max`. */
export const MAX_SCRIPT_BYTES = 512 * 1024;
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_MESSAGE_LENGTH = 200;
export const MAX_GAME_LENGTH = 64;
export const MAX_TAGS = 8;
export const TAG_REGEX = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const MAX_REPORT_DETAILS_LENGTH = 2000;
export const MAX_CLAIM_ITEMS = 100;
export const DEFAULT_PAGE_SIZE = 24;
/** Owner soft-delete grace period: undo is possible until then, the purge job runs after. */
export const DELETE_GRACE_DAYS = 30;
export const MAX_PAGE_SIZE = 100;

// ── Handles ──────────────────────────────────────────────────────────────────
/** 3–24 chars, lowercase, starts with a letter or digit. */
export const HANDLE_REGEX = /^[a-z0-9][a-z0-9_-]{2,23}$/;
/** Never assignable: route names, staff-looking names, brand. */
export const RESERVED_HANDLES = [
  "admin",
  "administrator",
  "api",
  "app",
  "auth",
  "cli",
  "dashboard",
  "device",
  "docs",
  "explore",
  "help",
  "legal",
  "login",
  "logout",
  "me",
  "mod",
  "moderator",
  "new",
  "null",
  "pasteblox",
  "pbx",
  "raw",
  "root",
  "s",
  "settings",
  "signup",
  "staff",
  "support",
  "system",
  "u",
  "undefined",
  "roblox",
  // service accounts: real users must not squat or impersonate them
  "rscripts",
] as const;
export const HANDLE_FORMAT_ERROR = "3–24 chars: a-z, 0-9, _ or -, starting with a letter or digit";
export const HANDLE_RESERVED_ERROR = "that handle is reserved";
/**
 * Zod-free mirror of `HandleSchema` for client bundles (zod is ~30 KB gz in the browser):
 * null when `h` (already trimmed + lowercased) is a valid handle, else the schema's message.
 */
export function handleFormatError(h: string): string | null {
  if (!HANDLE_REGEX.test(h)) return HANDLE_FORMAT_ERROR;
  if ((RESERVED_HANDLES as readonly string[]).includes(h)) return HANDLE_RESERVED_ERROR;
  return null;
}

// ── Enums (mirror the database enums) ─────────────────────────────────────
export const VISIBILITIES = ["public", "unlisted", "private"] as const;
export const LANGUAGES = ["luau", "lua"] as const;
export const PUSH_SOURCES = ["web", "cli", "api"] as const;
export const REPORT_REASONS = [
  "malware",
  "credential_theft",
  "webhook_logger",
  "spam",
  "copyright",
  "harassment",
  "illegal",
  "other",
] as const;
export const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;
export const SCRIPT_SORTS = ["updated", "created", "stars", "views", "fetches"] as const;
export const EXPLORE_SORTS = ["trending", "new", "top"] as const;

/**
 * Push-time safety heuristics. Stored on the version (and the latest set on the script).
 * Informational only: never blocks a push.
 */
export const SAFETY_FLAG_CODES = [
  "discord_webhook", // discord(app)?.com/api/webhooks/<id>/<token>
  "roblosecurity", // .ROBLOSECURITY / cookie access
  "ip_logger", // grabify, iplogger.*, etc.
  "http_exfil", // request/http_request/syn.request to a non-Roblox host
  "remote_loader", // loadstring(game:HttpGet(...)) – info only
  "env_tamper", // getfenv/setfenv combined with loadstring
  "escape_run", // long \ddd / \xHH escape runs
  "blob_line", // huge single-line base64/hex
  "obfuscator_signature", // known obfuscator headers (MoonSec, Luraph, Prometheus…)
] as const;
export const SAFETY_SEVERITIES = ["info", "warn", "high"] as const;

// ── API ──────────────────────────────────────────────────────────────────────
export const API_BASE_PATH = "/api/v1";
export const HEADER_API_KEY = "x-api-key";
export const HEADER_CLAIM_TOKEN = "x-claim-token";
export const HEADER_SCRIPT_VERSION = "x-pasteblox-version";
export const API_KEY_PREFIX = "pbx_";
/** `client_id` the CLI sends to /api/auth/device/code (checked by validateClient). */
export const CLI_CLIENT_ID = "pbx-cli";
/** CI/CLI env var holding an API key. */
export const TOKEN_ENV_VAR = "PASTEBLOX_TOKEN";
/** httpOnly cookie holding `slug.token` claim entries for anonymous web pastes. */
export const CLAIM_COOKIE = "pbx_claims";
/** Newest entries kept in CLAIM_COOKIE (~2.8 KB). */
export const MAX_CLAIM_COOKIE_ENTRIES = 50;

export const ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "gone",
  "conflict",
  "version_conflict",
  "payload_too_large",
  "invalid_content",
  "handle_taken",
  "rate_limited",
  "internal",
] as const;
