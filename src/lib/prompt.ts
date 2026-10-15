/** Minimal TTY prompts (confirm, text, select, multiselect) rendered on stderr. No deps. */
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { ce } from "./color";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI;
}

function abort(): never {
  process.stderr.write("\x1b[?25h\n");
  process.exit(130);
}

const q = () => ce.accent("?");

export async function confirm(message: string, defaultYes = false): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on("SIGINT", abort);
  try {
    const answer = (await rl.question(`${q()} ${message} ${ce.muted(defaultYes ? "[Y/n]" : "[y/N]")} `)).trim();
    if (!answer) return defaultYes;
    return /^y(es)?$/i.test(answer);
  } finally {
    rl.close();
  }
}

export async function text(message: string, defaultValue = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on("SIGINT", abort);
  try {
    const hint = defaultValue ? ` ${ce.muted(`(${defaultValue})`)}` : "";
    const answer = (await rl.question(`${q()} ${message}${hint} `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

interface Key {
  name?: string;
  ctrl?: boolean;
}

const WINDOW = 12;

/** Shared raw-mode list renderer. */
function listPrompt<T>(
  message: string,
  choices: Choice<T>[],
  opts: { multi: boolean; selected?: boolean[]; cursor?: number },
): Promise<T[]> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const err = process.stderr;
    let cursor = opts.cursor ?? 0;
    const selected = choices.map((_, i) => opts.selected?.[i] ?? false);
    let drawn = 0;
    const keys = opts.multi ? "↑↓ move · space toggle · a all · enter confirm" : "↑↓ move · enter select";

    const render = () => {
      if (drawn) err.write(`\x1b[${drawn}A\x1b[0J`);
      const start = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), choices.length - WINDOW));
      const end = Math.min(choices.length, start + WINDOW);
      const lines = [`${q()} ${message}  ${ce.muted(keys)}`];
      for (let i = start; i < end; i++) {
        const ch = choices[i] as Choice<T>;
        const pointer = i === cursor ? ce.accent("❯") : " ";
        const box = opts.multi ? `${selected[i] ? ce.accent("◉") : ce.muted("◯")} ` : "";
        const label = i === cursor ? ce.bold(ch.label) : ch.label;
        lines.push(`${pointer} ${box}${label}${ch.hint ? ` ${ce.muted(ch.hint)}` : ""}`);
      }
      if (choices.length > WINDOW) lines.push(ce.muted(`  ${end - start} of ${choices.length}`));
      err.write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    };

    const finish = (values: T[], summary: string) => {
      stdin.off("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      err.write(`\x1b[${drawn}A\x1b[0J`);
      err.write(`${ce.accent("✓")} ${message} ${ce.muted(summary)}\n\x1b[?25h`);
      resolve(values);
    };

    const onKey = (_s: string | undefined, key: Key | undefined) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        if (stdin.isTTY) stdin.setRawMode(false);
        abort();
      }
      switch (key.name) {
        case "up":
        case "k":
          cursor = (cursor - 1 + choices.length) % choices.length;
          break;
        case "down":
        case "j":
          cursor = (cursor + 1) % choices.length;
          break;
        case "space":
          if (opts.multi) selected[cursor] = !selected[cursor];
          break;
        case "a":
          if (opts.multi) {
            const all = selected.every(Boolean);
            selected.fill(!all);
          }
          break;
        case "return":
        case "enter": {
          if (opts.multi) {
            const values = choices.filter((_, i) => selected[i]).map((c) => c.value);
            finish(values, `${values.length} selected`);
          } else {
            const ch = choices[cursor] as Choice<T>;
            finish([ch.value], ch.label);
          }
          return;
        }
        default:
          return;
      }
      render();
    };

    emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    err.write("\x1b[?25l");
    stdin.on("keypress", onKey);
    render();
  });
}

export function multiselect<T>(message: string, choices: Choice<T>[], selected?: boolean[]): Promise<T[]> {
  return listPrompt(message, choices, { multi: true, selected });
}

export async function select<T>(message: string, choices: Choice<T>[], initial = 0): Promise<T> {
  const [v] = await listPrompt(message, choices, { multi: false, cursor: initial });
  return v as T;
}
