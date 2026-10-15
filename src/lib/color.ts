/**
 * Tiny color helper. Honors NO_COLOR, FORCE_COLOR, TERM=dumb and non-TTY streams.
 * Truecolor brand inks when the terminal says it can, plain ANSI otherwise.
 */

export type ColorLevel = 0 | 1 | 2 | 3;

type Env = Record<string, string | undefined>;

export function detectColorLevel(stream: { isTTY?: boolean }, env: Env = process.env): ColorLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return 0;
    if (force === "2") return 2;
    if (force === "3") return 3;
    // FORCE_COLOR=1 / true / "": at least basic; upgrade if the terminal advertises truecolor
    return supportsTruecolor(env) ? 3 : 1;
  }
  if (!stream.isTTY) return 0;
  if (env.TERM === "dumb") return 0;
  return supportsTruecolor(env) ? 3 : 1;
}

function supportsTruecolor(env: Env): boolean {
  const ct = env.COLORTERM?.toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return true;
  const tp = env.TERM_PROGRAM;
  if (tp === "iTerm.app" || tp === "WezTerm" || tp === "vscode" || tp === "ghostty" || tp === "Hyper") return true;
  if (env.WT_SESSION) return true;
  return false;
}

type Paint = (s: string | number) => string;

export interface Palette {
  level: ColorLevel;
  /** brand baby blue #8ccfff: the one token per line that matters */
  accent: Paint;
  /** secondary text */
  muted: Paint;
  /** coral #ff8b7b */
  error: Paint;
  /** bubblegum #ffadd0 */
  link: Paint;
  /** diff additions */
  add: Paint;
  bold: Paint;
  dim: Paint;
}

const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

function wrap(open: string, close: string): Paint {
  return (s) => `${open}${s}${close}`;
}

const plain: Paint = (s) => String(s);

export function makePalette(level: ColorLevel): Palette {
  if (level === 0) {
    return {
      level,
      accent: plain,
      muted: plain,
      error: plain,
      link: plain,
      add: plain,
      bold: plain,
      dim: plain,
    };
  }
  const fg = "\x1b[39m";
  const truecolor = level >= 3;
  return {
    level,
    accent: wrap(truecolor ? rgb(0x8c, 0xcf, 0xff) : "\x1b[96m", fg),
    muted: wrap(truecolor ? rgb(0x88, 0x92, 0xa0) : "\x1b[90m", fg),
    error: wrap(truecolor ? rgb(0xff, 0x8b, 0x7b) : "\x1b[31m", fg),
    link: wrap(truecolor ? rgb(0xff, 0xad, 0xd0) : "\x1b[95m", fg),
    add: wrap(truecolor ? rgb(0x9b, 0xd8, 0x8a) : "\x1b[32m", fg),
    bold: wrap("\x1b[1m", "\x1b[22m"),
    dim: wrap("\x1b[2m", "\x1b[22m"),
  };
}

/** stdout palette (results) */
export const c = makePalette(detectColorLevel(process.stdout));
/** stderr palette (errors, spinners, prompts) */
export const ce = makePalette(detectColorLevel(process.stderr));

/** --no-color: palettes are shared objects, so swap their functions in place. */
export function disableColor(): void {
  Object.assign(c, makePalette(0));
  Object.assign(ce, makePalette(0));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Visible width (ANSI stripped; good enough for our ASCII + a few symbols). */
export function visibleWidth(s: string): number {
  return [...stripAnsi(s)].length;
}
