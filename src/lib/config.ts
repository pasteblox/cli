/**
 * User-level state: ~/.config/pasteblox/{config,claims}.json (XDG_CONFIG_HOME respected,
 * %APPDATA%\pasteblox on Windows). Both files are 0600; keys are stored per API host so a
 * --dev login never leaks a production key to localhost (or vice versa).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors";

type Env = Record<string, string | undefined>;

export const TOKEN_ENV = "PASTEBLOX_TOKEN";

export function configDir(env: Env = process.env): string {
  if (env.PASTEBLOX_CONFIG_DIR) return env.PASTEBLOX_CONFIG_DIR;
  if (process.platform === "win32") {
    return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "pasteblox");
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pasteblox");
}

export const configPath = () => join(configDir(), "config.json");
export const claimsPath = () => join(configDir(), "claims.json");

export interface HostEntry {
  apiKey: string;
  keyId: string;
  user: { handle: string; name: string };
  deviceName?: string;
  createdAt: string;
}

interface ConfigFile {
  version: 1;
  hosts: Record<string, HostEntry>;
}

export interface ClaimEntry {
  slug: string;
  token: string;
  createdAt: string;
}

interface ClaimsFile {
  version: 1;
  hosts: Record<string, ClaimEntry[]>;
}

function readJsonFile<T>(path: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as T & { hosts?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.hosts !== "object") return fallback;
    return parsed;
  } catch {
    throw new CliError(`${path} isn't valid JSON`, { hint: "fix it or delete it, then pbx login again" });
  }
}

/** Atomic write, 0700 dir, 0600 file. */
export function writeSecureJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // chmod is a no-op on some Windows filesystems
  }
  renameSync(tmp, path);
}

function readConfig(): ConfigFile {
  return readJsonFile<ConfigFile>(configPath(), { version: 1, hosts: {} });
}

export function getHostEntry(base: string): HostEntry | undefined {
  return readConfig().hosts[base];
}

export function setHostEntry(base: string, entry: HostEntry): void {
  const cfg = readConfig();
  cfg.hosts[base] = entry;
  writeSecureJson(configPath(), cfg);
}

/** Returns true when something was removed. Deletes the file when no hosts remain. */
export function deleteHostEntry(base: string): boolean {
  const cfg = readConfig();
  if (!cfg.hosts[base]) return false;
  delete cfg.hosts[base];
  if (Object.keys(cfg.hosts).length === 0) rmSync(configPath(), { force: true });
  else writeSecureJson(configPath(), cfg);
  return true;
}

export interface ResolvedAuth {
  apiKey: string;
  source: "env" | "config";
  entry?: HostEntry;
}

export function resolveAuth(base: string, env: Env = process.env): ResolvedAuth | null {
  const fromEnv = env[TOKEN_ENV]?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  const entry = getHostEntry(base);
  if (entry?.apiKey) return { apiKey: entry.apiKey, source: "config", entry };
  return null;
}

// ── claim tokens for anonymous scripts ───────────────────────────────────────

function readClaims(): ClaimsFile {
  return readJsonFile<ClaimsFile>(claimsPath(), { version: 1, hosts: {} });
}

export function getClaims(base: string): ClaimEntry[] {
  return readClaims().hosts[base] ?? [];
}

export function getClaimToken(base: string, slug: string): string | undefined {
  return getClaims(base).find((c) => c.slug === slug)?.token;
}

export function addClaim(base: string, entry: ClaimEntry): void {
  const file = readClaims();
  const list = (file.hosts[base] ?? []).filter((c) => c.slug !== entry.slug);
  list.push(entry);
  file.hosts[base] = list;
  writeSecureJson(claimsPath(), file);
}

export function removeClaims(base: string, slugs: string[]): void {
  if (slugs.length === 0) return;
  const file = readClaims();
  const drop = new Set(slugs);
  const list = (file.hosts[base] ?? []).filter((c) => !drop.has(c.slug));
  if (list.length) file.hosts[base] = list;
  else delete file.hosts[base];
  if (Object.keys(file.hosts).length === 0) rmSync(claimsPath(), { force: true });
  else writeSecureJson(claimsPath(), file);
}
