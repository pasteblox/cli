# pbx

The command line for [pasteblox.com](https://pasteblox.com). Push, pull, diff and watch your Roblox/Luau scripts like code, and get a `loadstring` that never breaks when you ship a fix.

```sh
pbx push door.luau
✓ door.luau → k3m9x2p7qa v1 · new unlisted script · 1.9kb · 120ms
  slug        k3m9x2p7qa
  page        https://pasteblox.com/s/k3m9x2p7qa
  raw         https://pasteblox.com/raw/k3m9x2p7qa
  loadstring  loadstring(game:HttpGet("https://pasteblox.com/raw/k3m9x2p7qa"))()
```

## Install

```sh
bunx pasteblox --help        # no install, runs with bun
npx pasteblox --help         # no install, runs with node ≥ 18
npm i -g pasteblox           # puts `pbx` (and `pasteblox`) on your PATH
bun add -g pasteblox
```

The npm package is one ESM file with zero dependencies.

**No runtime at all?** Grab a standalone binary from the [releases page](https://github.com/pasteblox/cli/releases/latest): `pbx-darwin-arm64`, `pbx-darwin-x64`, `pbx-linux-x64`, `pbx-linux-arm64` or `pbx-windows-x64.exe`. Make it executable and put it somewhere on your PATH:

```sh
chmod +x pbx-darwin-arm64 && mv pbx-darwin-arm64 /usr/local/bin/pbx
```

## Quickstart

```sh
pbx login              # once per machine: approve the code in your browser
cd my-game-scripts
pbx init               # pick which .luau/.lua files pbx tracks → pasteblox.json
pbx push               # creates them all, prints the loadstrings
pbx watch              # from now on, every save is a new version
```

You don't need an account to try it. Logged-out pushes create unlisted scripts, and pbx keeps their edit tokens. `pbx login` later claims them to your account.

## Commands

Run `pbx help <command>` for the full flag list. Every command takes `--json`, `--api <url>`, `--dev` and `-h/--help`.

Wherever a command takes `<slug>`, it also accepts `slug@n`, a page or raw URL, or a file that's mapped in `pasteblox.json`. If the project maps exactly one script, you can leave the slug out.

| command | what it does |
|---|---|
| `pbx login [--no-browser] [--force]` | Device login. pbx prints a code, opens `pasteblox.com/device`, and waits for you to approve it. Then it stores an API key for this machine. |
| `pbx logout` | Revokes this machine's key on the server and deletes it locally. |
| `pbx whoami` | Shows the account and key you're pushing as. |
| `pbx init [--yes] [-f file]… [--public\|--unlisted\|--private]` | Writes `pasteblox.json`. In a terminal you pick files from a list; in scripts and CI, pass `--yes` (every file found) or `-f`. |
| `pbx push [file] [-m msg] [-t title] [-s slug] [--public\|--unlisted\|--private] [--force]` | A mapped file gets a new version. An unmapped file becomes a new script and is added to `pasteblox.json`. With no file, pbx pushes every mapped file that changed since the last push. |
| `pbx pull <slug> [--version n] [-o file] [--force]` | Downloads a script, by default to its mapped file or `<slug>.luau`. pbx won't overwrite local changes you haven't pushed unless you pass `--force`. |
| `pbx watch` | Watches every mapped file and pushes about 400 ms after you save. Errors don't stop the loop, rate limits retry on their own, and ctrl-c exits. |
| `pbx diff <slug> [file] [--from n] [--to m]` | A git-style unified diff of your local file against the latest version, or between two versions. |
| `pbx log <slug> [-n 20]` | Version history, newest first. |
| `pbx ls [--visibility v] [--sort updated\|created\|stars\|views\|fetches] [-n 100]` | Lists your scripts. |
| `pbx open <slug> [--raw]` | Opens the script page, or its raw URL, in your browser. |
| `pbx loadstring <slug> [--version n] [--no-copy]` | Prints the loader one-liner and copies it to your clipboard. `--version` pins it to that version. |
| `pbx rm <slug> [--yes]` | Deletes the script, which stops its raw URL. In a terminal pbx asks first; anywhere else you have to pass `--yes`. |
| `pbx --version`, `pbx help [command]` | |

### Concurrency

pbx remembers the version each file was last pushed or pulled at, in `.pasteblox/state.json`, and sends it as `baseVersion`. Say someone pushed from the web in the meantime. Your push then stops with `remote moved on: … is at v8, you're based on v7`. To catch up, run `pbx pull <slug> --force`; to overwrite theirs, run `pbx push --force`.

A fresh clone or a CI checkout has no state yet, so the files in the repo win.

## pasteblox.json

```json
{
  "$schema": "https://pasteblox.com/schema/pasteblox.json",
  "scripts": [
    { "file": "src/door.luau", "slug": "k3m9x2p7qa", "visibility": "unlisted", "title": "door" },
    { "file": "src/hub.lua", "visibility": "public", "title": "speed hub" }
  ]
}
```

Commit this file. A script without a `slug` is created on the next `pbx push`, and pbx writes the slug back into the file. The JSON Schema is in [`pasteblox.schema.json`](./pasteblox.schema.json), and the site should serve it at the `$schema` URL.

Local state goes in `.pasteblox/`, which ignores itself with its own `.gitignore`.

## CI

Create an API key in the dashboard and put it in `PASTEBLOX_TOKEN`. It takes priority over any stored login.

```yaml
# .github/workflows/pasteblox.yml
on: { push: { branches: [main] } }
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx pasteblox push -m "ci: ${GITHUB_SHA::7}" --json
        env:
          PASTEBLOX_TOKEN: ${{ secrets.PASTEBLOX_TOKEN }}
```

Outside a TTY, pbx never prompts, never animates and never colors (unless you set `FORCE_COLOR`). Anything that would need a question, such as `init` or `rm`, fails with exit code 2 and tells you which flag to add.

## Machine output

`--json` prints a single JSON document on stdout. The exceptions are `watch` and `login`, which stream one JSON object per line (`{"event":"push",…}`). Errors become `{"error":{"code","message","hint",…}}` on stdout, with a non-zero exit.

| exit | meaning |
|---|---|
| 0 | ok |
| 1 | error: api, network or local state; the message says what to do next |
| 2 | usage: bad flag, missing argument, or a confirmation that needs `--yes` |

## Environment

| variable | effect |
|---|---|
| `PASTEBLOX_TOKEN` | API key. Overrides the stored login. |
| `PASTEBLOX_API` | API base URL (default `https://pasteblox.com`). `--api` overrides it. `--dev` means `http://localhost:3100` when this variable is unset. |
| `NO_COLOR` / `FORCE_COLOR` | Turn color off or force it on. `--no-color` does the same as `NO_COLOR`. |
| `XDG_CONFIG_HOME` | Where the config lives: `$XDG_CONFIG_HOME/pasteblox` (default `~/.config/pasteblox`; `%APPDATA%\pasteblox` on Windows). |
| `PASTEBLOX_CONFIG_DIR` | Overrides the config directory entirely. |
| `PBX_DEBUG` | Prints contract-mismatch details and stack traces. |

pbx keeps two files in the config directory, both mode 0600: `config.json` (API keys, one per API host) and `claims.json` (edit tokens for scripts you pushed anonymously).

## Development

```sh
bun install                   # at the repo root
bun run dev -- push x.luau    # run from source
bun run build                 # dist/pbx.js: node ESM bundle, shared contract + zod inlined
bun run build:bin             # dist/bin/pbx-<target> for every target (or pass targets)
bun run test                  # unit + e2e under bun, then e2e against the node bundle
PBX_TEST_RUNNER=bin bun test test/e2e.test.ts   # e2e against the compiled binary
bun run typecheck && bun run lint
bun scripts/bench-startup.ts  # startup timings
bun test/mock-server.ts       # a contract mock api to point --api at
```

The e2e suite runs the real CLI as a subprocess against `test/mock-server.ts`. That mock validates every request and response with the `@pasteblox/shared` Zod schemas, so if the CLI and the contract drift apart, the suite goes red.
