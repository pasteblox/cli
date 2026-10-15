export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export interface CliErrorOptions {
  /** what to do next, printed under the message */
  hint?: string;
  /** stable machine code for --json (api error code, or a cli code like "not_logged_in") */
  code?: string;
  exitCode?: number;
  /** api error extras (retryAfter, latestVersion…) */
  details?: Record<string, unknown>;
}

/** An error that is the user's next step, not a stack trace. */
export class CliError extends Error {
  hint?: string;
  code: string;
  exitCode: number;
  details?: Record<string, unknown>;

  constructor(message: string, opts: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.hint = opts.hint;
    this.code = opts.code ?? "error";
    this.exitCode = opts.exitCode ?? EXIT_ERROR;
    this.details = opts.details;
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { hint, code: "usage", exitCode: EXIT_USAGE });
    this.name = "UsageError";
  }
}

export function notLoggedIn(): CliError {
  return new CliError("not logged in", {
    hint: "run pbx login (or set PASTEBLOX_TOKEN for CI)",
    code: "not_logged_in",
  });
}
