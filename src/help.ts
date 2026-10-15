import { COMMANDS, type CommandDef, GLOBAL_FLAGS } from "./commands/registry";
import type { FlagSpecs } from "./lib/args";
import { c } from "./lib/color";
import { padEnd } from "./lib/ui";
import { VERSION } from "./lib/version";

const section = (title: string) => c.bold(title);

function flagRows(specs: FlagSpecs): [string, string][] {
  return Object.entries(specs)
    .filter(([, s]) => !s.hidden)
    .map(([name, s]) => {
      const short = s.short ? `-${s.short}, ` : "    ";
      const value = s.type === "string" ? ` ${s.placeholder ?? "<value>"}` : "";
      const def = s.defaultLabel ? c.muted(` (default: ${s.defaultLabel})`) : "";
      return [`${short}--${name}${value}`, `${s.desc}${def}`];
    });
}

function rows(pairs: [string, string][], indent = 2, minWidth = 0): string[] {
  const w = Math.max(minWidth, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${" ".repeat(indent)}${padEnd(k, w)}   ${v}`);
}

export function overviewHelp(): string {
  const groups: [string, CommandDef["group"]][] = [
    ["auth", "auth"],
    ["project", "project"],
    ["scripts", "scripts"],
  ];
  const lines = [
    `${c.accent(c.bold("pbx"))} ${c.muted(`v${VERSION}`)} ${c.muted("·")} your roblox scripts, versioned like code`,
    "",
    section("usage"),
    "  pbx <command> [flags]",
    "",
  ];
  const nameW = Math.max(...COMMANDS.map((cmd) => cmd.name.length));
  for (const [title, group] of groups) {
    lines.push(section(title));
    lines.push(
      ...rows(
        COMMANDS.filter((cmd) => cmd.group === group).map((cmd) => [cmd.name, cmd.summary] as [string, string]),
        2,
        nameW,
      ),
    );
    lines.push("");
  }
  lines.push(section("global flags"));
  lines.push(...rows([...flagRows(GLOBAL_FLAGS), ["-v, --version", "print the version"]]));
  lines.push("");
  lines.push(section("get going"));
  lines.push(
    ...rows([
      ["pbx login", "once per machine"],
      ["pbx push door.luau", "creates the script, prints the loadstring"],
      ["pbx watch", "push on every save"],
    ]),
  );
  lines.push("");
  lines.push(
    `${c.muted("run")} pbx help <command> ${c.muted("for details · ci: set")} PASTEBLOX_TOKEN ${c.muted("·")} ${c.link("https://pasteblox.com/cli")}`,
  );
  return lines.join("\n");
}

export function commandHelp(cmd: CommandDef): string {
  const lines = [`${c.accent(c.bold(`pbx ${cmd.name}`))} ${c.muted("—")} ${cmd.summary}`];
  if (cmd.description) lines.push("", cmd.description);
  lines.push("", section("usage"), `  ${cmd.usage}`);
  if (cmd.examples.length) {
    lines.push("", section("examples"));
    lines.push(...rows(cmd.examples.map(([ex, what]) => [ex, c.muted(what)] as [string, string])));
  }
  const own = flagRows(cmd.flags);
  if (own.length) lines.push("", section("flags"), ...rows(own));
  lines.push("", section("global flags"), ...rows(flagRows(GLOBAL_FLAGS)));
  return lines.join("\n");
}
