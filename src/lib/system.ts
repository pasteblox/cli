/** Browser + clipboard, via whatever the OS ships. Never throws: callers degrade gracefully. */
import { spawn } from "node:child_process";
import { hostname } from "node:os";

function trySpawn(cmd: string, args: string[], input?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        stdio: input === undefined ? "ignore" : ["pipe", "ignore", "ignore"],
        detached: input === undefined,
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    if (input === undefined) {
      // fire and forget: success once the opener started
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
      return;
    }
    child.once("close", (code) => resolve(code === 0));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export async function openUrl(url: string): Promise<boolean> {
  if (process.platform === "darwin") return trySpawn("open", [url]);
  // what `start` does under the hood, minus cmd.exe's quoting rules mangling `&` in query strings
  if (process.platform === "win32") return trySpawn("rundll32", ["url.dll,FileProtocolHandler", url]);
  return trySpawn("xdg-open", [url]);
}

/** Returns the tool that worked (pbcopy, wl-copy, …) or null. */
export async function copyToClipboard(text: string): Promise<string | null> {
  const candidates: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip.exe", []]]
        : [
            ...(process.env.WAYLAND_DISPLAY ? ([["wl-copy", []]] as [string, string[]][]) : []),
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
            ["clip.exe", []], // WSL
          ];
  for (const [cmd, args] of candidates) {
    if (await trySpawn(cmd, args, text)) return cmd;
  }
  return null;
}

export function deviceName(): string {
  const h = hostname().replace(/\.(local|lan|home)$/i, "");
  return (h || "unknown-device").slice(0, 64);
}

export function platformLabel(): string {
  return `${process.platform}-${process.arch}`;
}
