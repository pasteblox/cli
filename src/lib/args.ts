/**
 * Hand-rolled flag parser (no deps, works on Node 18): --flag, --flag=value, --flag value,
 * -f value, -abc (boolean groups), --no-flag, and `--` to end flags.
 */
import { UsageError } from "./errors";

export interface FlagSpec {
  type: "boolean" | "string";
  short?: string;
  /** collect repeated values into an array */
  multiple?: boolean;
  desc: string;
  /** shown in help: --message <text> */
  placeholder?: string;
  /** shown in help only; commands apply defaults themselves */
  defaultLabel?: string;
  hidden?: boolean;
}

export type FlagSpecs = Record<string, FlagSpec>;
export type FlagValue = string | boolean | string[] | undefined;

export interface ParsedArgs {
  flags: Record<string, FlagValue>;
  positionals: string[];
}

export function parseArgs(argv: string[], specs: FlagSpecs, cmdName: string): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  const shortMap = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) if (spec.short) shortMap.set(spec.short, name);

  const set = (name: string, value: string | boolean) => {
    const spec = specs[name];
    if (spec?.multiple && typeof value === "string") {
      const prev = flags[name];
      flags[name] = Array.isArray(prev) ? [...prev, value] : [value];
    } else flags[name] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      let name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let inline: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
      let spec = specs[name];
      if (!spec && name.startsWith("no-") && specs[name.slice(3)]?.type === "boolean") {
        name = name.slice(3);
        spec = specs[name];
        inline = "false";
      }
      if (!spec) throw unknownFlag(`--${name}`, specs, cmdName);
      if (spec.type === "boolean") {
        set(name, inline === undefined ? true : !(inline === "false" || inline === "0"));
      } else {
        if (inline === undefined) {
          const next = argv[i + 1];
          if (next === undefined || (next.startsWith("-") && next !== "-")) {
            throw new UsageError(
              `--${name} needs a value`,
              `e.g. pbx ${cmdName} --${name} ${spec.placeholder ?? "<value>"}`,
            );
          }
          inline = next;
          i++;
        }
        set(name, inline);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) {
      const body = arg.slice(1);
      for (let j = 0; j < body.length; j++) {
        const ch = body[j] as string;
        const name = shortMap.get(ch);
        if (!name) throw unknownFlag(`-${ch}`, specs, cmdName);
        const spec = specs[name] as FlagSpec;
        if (spec.type === "boolean") {
          set(name, true);
          continue;
        }
        // string short flag: rest of the group (or "=value") is the value, else the next arg
        let rest = body.slice(j + 1);
        if (rest.startsWith("=")) rest = rest.slice(1);
        if (rest) set(name, rest);
        else {
          const next = argv[i + 1];
          if (next === undefined) {
            throw new UsageError(`-${ch} needs a value`, `e.g. pbx ${cmdName} -${ch} ${spec.placeholder ?? "<value>"}`);
          }
          set(name, next);
          i++;
        }
        break;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

function unknownFlag(flag: string, specs: FlagSpecs, cmdName: string): UsageError {
  const names = Object.entries(specs)
    .filter(([, s]) => !s.hidden)
    .map(([n]) => `--${n}`);
  const guess = closest(flag.replace(/^-+/, "--"), names);
  return new UsageError(`unknown flag ${flag}${guess ? ` (did you mean ${guess}?)` : ""}`, `see pbx ${cmdName} --help`);
}

/** Levenshtein-based suggestion; null when nothing is close. */
export function closest(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const cand of candidates) {
    const d = levenshtein(input, cand);
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return best !== null && bestD <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min((prev[j] as number) + 1, (prev[j - 1] as number) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

export const str = (v: FlagValue): string | undefined => (typeof v === "string" ? v : undefined);
export const bool = (v: FlagValue): boolean => v === true;
export const list = (v: FlagValue): string[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);

export function intFlag(v: FlagValue, name: string, min = 1): number | undefined {
  if (v === undefined) return undefined;
  const s = String(v).replace(/^v/i, "");
  const n = Number(s);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be a whole number ≥ ${min}, got "${v}"`);
  return n;
}
