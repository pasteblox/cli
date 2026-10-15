#!/usr/bin/env node
import { COMMANDS, type CommandDef, findCommand, GLOBAL_FLAGS } from "./commands/registry";
import { commandHelp, overviewHelp } from "./help";
import { bool, closest, type FlagValue, parseArgs, str } from "./lib/args";
import { disableColor } from "./lib/color";
import { EXIT_OK, UsageError } from "./lib/errors";
import { printError, setJsonMode } from "./lib/ui";
import { VERSION } from "./lib/version";

export const DEFAULT_API = "https://pasteblox.com";
export const DEV_API = "http://localhost:3100";

const ALIASES: Record<string, string> = {
  list: "ls",
  delete: "rm",
  remove: "rm",
  history: "log",
  ls: "ls",
};

export function resolveBase(flags: Record<string, FlagValue>, env = process.env): string {
  const raw = str(flags.api) ?? env.PASTEBLOX_API ?? (flags.dev === true ? DEV_API : DEFAULT_API);
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new UsageError(`"${raw}" isn't a url`, "e.g. --api https://pasteblox.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`--api must be http(s), got ${url.protocol}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Index of the command token: first arg that isn't a flag or a global flag's value. */
function commandIndex(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return -1;
    if (a === "--api") {
      i++;
      continue;
    }
    if (!a.startsWith("-")) return i;
  }
  return -1;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--no-color")) disableColor();
  if (argv.includes("--json")) setJsonMode(true);

  const idx = commandIndex(argv);
  if (idx === -1) {
    if (argv.includes("--version") || argv.includes("-v")) {
      if (argv.includes("--json")) process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
      else process.stdout.write(`${VERSION}\n`);
      return EXIT_OK;
    }
    // validate stray flags so `pbx --jsn` doesn't silently print help
    parseArgs(argv, { ...GLOBAL_FLAGS, version: { type: "boolean", short: "v", desc: "" } }, "");
    process.stdout.write(`${overviewHelp()}\n`);
    return EXIT_OK;
  }

  const name = argv[idx] as string;
  const rest = [...argv.slice(0, idx), ...argv.slice(idx + 1)];

  if (name === "help") {
    const target = rest.find((a) => !a.startsWith("-"));
    if (!target) {
      process.stdout.write(`${overviewHelp()}\n`);
      return EXIT_OK;
    }
    const cmd = lookup(target);
    process.stdout.write(`${commandHelp(cmd)}\n`);
    return EXIT_OK;
  }

  const cmd = lookup(name);
  const { flags, positionals } = parseArgs(rest, { ...GLOBAL_FLAGS, ...cmd.flags }, cmd.name);
  if (bool(flags.help)) {
    process.stdout.write(`${commandHelp(cmd)}\n`);
    return EXIT_OK;
  }
  const json = bool(flags.json);
  setJsonMode(json);
  const base = resolveBase(flags);
  const mod = await cmd.load();
  const code = await mod.run({ name: cmd.name, args: positionals, flags, json, base });
  return code ?? EXIT_OK;
}

function lookup(name: string): CommandDef {
  const cmd = findCommand(ALIASES[name] ?? name);
  if (cmd) return cmd;
  const guess = closest(
    name,
    COMMANDS.map((c) => c.name),
  );
  throw new UsageError(
    `unknown command "${name}"${guess ? ` (did you mean ${guess}?)` : ""}`,
    "run pbx --help for the list",
  );
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.exitCode = printError(e);
  },
);
