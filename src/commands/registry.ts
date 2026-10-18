/**
 * Command metadata (help, flags) with lazy loaders, so `pbx --help` / `--version`
 * never evaluate zod or the API client.
 */
import type { FlagSpecs, FlagValue } from "../lib/args";

export interface CommandContext {
  name: string;
  args: string[];
  flags: Record<string, FlagValue>;
  json: boolean;
  /** API origin without trailing slash, e.g. https://pasteblox.com */
  base: string;
}

export type Run = (ctx: CommandContext) => Promise<number | undefined>;

export interface CommandDef {
  name: string;
  group: "auth" | "scripts" | "project";
  summary: string;
  /** one or two sentences under the title in `--help` */
  description?: string;
  usage: string;
  examples: [string, string][];
  flags: FlagSpecs;
  load: () => Promise<{ run: Run }>;
}

const visibilityFlags: FlagSpecs = {
  public: { type: "boolean", desc: "listed on explore (needs login)" },
  unlisted: { type: "boolean", desc: "anyone with the link (default)" },
  private: { type: "boolean", desc: "only you (needs login)" },
};

const notesFlags: FlagSpecs = {
  notes: {
    type: "string",
    multiple: true,
    placeholder: "<text>",
    desc: "changelog: bullets, ## headings, **bold**, `code` (repeat for more lines)",
  },
  "notes-file": { type: "string", placeholder: "<path>", desc: "read the changelog from a file, - for stdin" },
};

export const GLOBAL_FLAGS: FlagSpecs = {
  json: { type: "boolean", desc: "machine-readable output on stdout" },
  api: {
    type: "string",
    placeholder: "<url>",
    desc: "api base url, or env PASTEBLOX_API",
    defaultLabel: "https://pasteblox.com",
  },
  dev: { type: "boolean", desc: "use http://localhost:3100 when PASTEBLOX_API is unset" },
  "no-color": { type: "boolean", desc: "disable colors (or set NO_COLOR)" },
  help: { type: "boolean", short: "h", desc: "show help" },
};

export const COMMANDS: CommandDef[] = [
  {
    name: "login",
    group: "auth",
    summary: "sign in from the browser",
    description:
      "opens pasteblox.com, you approve the code, pbx stores an api key for this device. anonymous scripts you pushed earlier get claimed to your account.",
    usage: "pbx login [flags]",
    examples: [
      ["pbx login", "open the browser and wait for approval"],
      ["pbx login --no-browser", "print the link instead (ssh, containers)"],
    ],
    flags: {
      "no-browser": { type: "boolean", desc: "don't open a browser, just print the link" },
      force: { type: "boolean", desc: "log in again even if already logged in" },
    },
    load: () => import("./login"),
  },
  {
    name: "logout",
    group: "auth",
    summary: "revoke this device's key and forget it",
    usage: "pbx logout",
    examples: [["pbx logout", "revoke the key server-side and delete it locally"]],
    flags: {},
    load: () => import("./logout"),
  },
  {
    name: "whoami",
    group: "auth",
    summary: "who you're pushing as",
    usage: "pbx whoami",
    examples: [["pbx whoami", "show the account behind the current key"]],
    flags: {},
    load: () => import("./whoami"),
  },
  {
    name: "init",
    group: "project",
    summary: "map local .luau/.lua files to scripts",
    description:
      "writes pasteblox.json in the current directory. interactive in a terminal; pass --file or --yes in scripts and CI.",
    usage: "pbx init [flags]",
    examples: [
      ["pbx init", "pick files from a list"],
      ["pbx init --yes", "map every .luau/.lua file found"],
      ["pbx init -f src/door.luau -f src/hub.lua --private", "map specific files"],
    ],
    flags: {
      file: { type: "string", short: "f", multiple: true, placeholder: "<path>", desc: "file to map (repeatable)" },
      yes: { type: "boolean", short: "y", desc: "map every detected file without asking" },
      ...visibilityFlags,
    },
    load: () => import("./init"),
  },
  {
    name: "push",
    group: "scripts",
    summary: "upload a new version (or create the script)",
    description:
      "mapped files get a new version; unmapped files become new scripts and are added to pasteblox.json. with no file, pushes every mapped file that changed since the last push, each with the same message and notes.",
    usage: "pbx push [file] [flags]",
    examples: [
      ["pbx push", "push every mapped file that changed"],
      ['pbx push src/door.luau -m "fix debounce"', "push one file with a message"],
      ['pbx push hub.lua --public --title "speed hub"', "create a public script"],
      ["pbx push door.luau --slug k3m9x2p7qa", "push into an existing script"],
      ['pbx push -m "v2" --notes "- added: auto farm" --notes "- fixed: lag"', "summary plus a changelog"],
      ["git log -1 --format=%b | pbx push --notes-file -", "changelog from stdin"],
    ],
    flags: {
      message: { type: "string", short: "m", placeholder: "<text>", desc: "version summary (one line)" },
      ...notesFlags,
      title: { type: "string", short: "t", placeholder: "<text>", desc: "script title", defaultLabel: "file name" },
      slug: { type: "string", short: "s", placeholder: "<slug>", desc: "push into this script and map the file to it" },
      ...visibilityFlags,
      force: { type: "boolean", desc: "push even if the remote moved on since your last push/pull" },
    },
    load: () => import("./push"),
  },
  {
    name: "pull",
    group: "scripts",
    summary: "download a script",
    description:
      "writes the latest (or a pinned) version to disk. refuses to overwrite local changes you haven't pushed unless you pass --force.",
    usage: "pbx pull <slug> [flags]",
    examples: [
      ["pbx pull k3m9x2p7qa", "write the latest version to its mapped file or <slug>.luau"],
      ["pbx pull k3m9x2p7qa --version 3 -o old.luau", "grab v3 into old.luau"],
    ],
    flags: {
      version: { type: "string", placeholder: "<n>", desc: "pinned version", defaultLabel: "latest" },
      output: { type: "string", short: "o", placeholder: "<file>", desc: "where to write it" },
      force: { type: "boolean", desc: "overwrite local changes" },
    },
    load: () => import("./pull"),
  },
  {
    name: "watch",
    group: "scripts",
    summary: "push mapped files on save",
    description: "watches every file in pasteblox.json and pushes ~400ms after the last save. ctrl-c to stop.",
    usage: "pbx watch [flags]",
    examples: [
      ["pbx watch", "push on every save"],
      ["pbx watch --json", "one json line per push, for tooling"],
    ],
    flags: {},
    load: () => import("./watch"),
  },
  {
    name: "diff",
    group: "scripts",
    summary: "local file vs remote, git-style",
    usage: "pbx diff <slug> [file] [flags]",
    examples: [
      ["pbx diff k3m9x2p7qa", "mapped file vs latest"],
      ["pbx diff src/door.luau", "same, by file"],
      ["pbx diff k3m9x2p7qa --from 3 --to 5", "between two versions"],
    ],
    flags: {
      from: { type: "string", placeholder: "<n>", desc: "old side version", defaultLabel: "latest" },
      to: { type: "string", placeholder: "<n>", desc: "new side version", defaultLabel: "local file" },
    },
    load: () => import("./diff"),
  },
  {
    name: "log",
    group: "scripts",
    summary: "version history",
    description: "newest first, each version's changelog indented under its summary.",
    usage: "pbx log <slug> [flags]",
    examples: [
      ["pbx log k3m9x2p7qa", "recent versions, newest first"],
      ["pbx log src/door.luau -n 50 --short", "by file, more history, summaries only"],
    ],
    flags: {
      limit: { type: "string", short: "n", placeholder: "<n>", desc: "how many versions", defaultLabel: "20" },
      short: { type: "boolean", desc: "one line per version, no changelogs" },
    },
    load: () => import("./log"),
  },
  {
    name: "note",
    group: "scripts",
    summary: "rewrite a version's summary or changelog",
    description:
      'fixes the message and notes of a version you already pushed; the code never changes. without a version number it edits the latest. --notes "" clears the changelog.',
    usage: "pbx note <slug> [n] [flags]",
    examples: [
      ['pbx note k3m9x2p7qa 3 -m "fix door debounce"', "reword v3's summary"],
      ["pbx note src/door.luau --notes-file CHANGELOG.md", "changelog for the latest version"],
      ['pbx note k3m9x2p7qa@2 --notes ""', "clear v2's changelog"],
    ],
    flags: {
      message: { type: "string", short: "m", placeholder: "<text>", desc: "new summary (one line)" },
      ...notesFlags,
    },
    load: () => import("./note"),
  },
  {
    name: "ls",
    group: "scripts",
    summary: "your scripts",
    usage: "pbx ls [flags]",
    examples: [
      ["pbx ls", "everything you own, recently updated first"],
      ["pbx ls --visibility public --sort views", "your public hits"],
    ],
    flags: {
      visibility: { type: "string", placeholder: "<v>", desc: "public, unlisted or private" },
      sort: {
        type: "string",
        placeholder: "<key>",
        desc: "updated, created, stars, views, fetches",
        defaultLabel: "updated",
      },
      limit: { type: "string", short: "n", placeholder: "<n>", desc: "max rows", defaultLabel: "100" },
    },
    load: () => import("./ls"),
  },
  {
    name: "open",
    group: "scripts",
    summary: "open a script page in the browser",
    usage: "pbx open <slug> [flags]",
    examples: [
      ["pbx open k3m9x2p7qa", "open the page"],
      ["pbx open src/door.luau --raw", "open the raw url of a mapped file"],
    ],
    flags: { raw: { type: "boolean", desc: "open the raw url instead" } },
    load: () => import("./open"),
  },
  {
    name: "loadstring",
    group: "scripts",
    summary: "print + copy the loader one-liner",
    usage: "pbx loadstring <slug> [flags]",
    examples: [
      ["pbx loadstring k3m9x2p7qa", "always the latest version"],
      ["pbx loadstring k3m9x2p7qa --version 4", "pinned to v4, never changes"],
    ],
    flags: {
      version: { type: "string", placeholder: "<n>", desc: "pin a version", defaultLabel: "latest" },
      "no-copy": { type: "boolean", desc: "don't touch the clipboard" },
    },
    load: () => import("./loadstring"),
  },
  {
    name: "rm",
    group: "scripts",
    summary: "delete a script",
    description: "the raw url stops working immediately. asks first in a terminal; pass --yes in scripts.",
    usage: "pbx rm <slug> [flags]",
    examples: [
      ["pbx rm k3m9x2p7qa", "delete after confirming"],
      ["pbx rm k3m9x2p7qa --yes", "no questions"],
    ],
    flags: { yes: { type: "boolean", short: "y", desc: "skip the confirmation" } },
    load: () => import("./rm"),
  },
  {
    name: "restore",
    group: "scripts",
    summary: "bring back a deleted script",
    description: "undo pbx rm while the script is still soft-deleted. same slug, same raw url.",
    usage: "pbx restore <slug>",
    examples: [["pbx restore k3m9x2p7qa", "undo a delete"]],
    flags: {},
    load: () => import("./restore"),
  },
];

export function findCommand(name: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.name === name);
}
