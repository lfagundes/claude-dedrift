# claude-dedrift

Make Claude Code actually honor your `CLAUDE.md` and provided context.

## Why

Claude Code wraps your context (CLAUDE.md, rules, project instructions) in a
`<system-reminder>` that tells the model the content *"may or may not be relevant"*
and that it *"should not respond to this context unless it is highly relevant."*
That wording lets the agent quietly discount standing instructions.

`claude-dedrift` patches the Claude Code binary to replace that wrapper with:

> IMPORTANT: these are the user's authoritative standing instructions. Obey
> every one that applies to the current task; do not discount them.

This keeps you in control: an instruction that misfires is something you *see* and
fix in the file — not something the agent silently decides to ignore. It obeys the
parts that apply to the task at hand and stays quiet on the parts that don't, rather
than forcing in irrelevant context or dismissing everything.

The replacement is exactly the same length as the original, so the executable is
never restructured — only 147 bytes (in two places) change.

## Install

```sh
npm install -g claude-dedrift
claude-dedrift install
```

Then restart your shell (or `source` your rc file). That's it.

`install` sets up a **self-healing shim**: a tiny `claude` wrapper earlier on your
PATH that re-applies the patch automatically whenever Claude Code auto-updates to a
new version. You keep typing `claude` as always; the patch heals itself. If patching
ever fails, the shim still launches Claude Code normally (unpatched) — it never
blocks you.

## Commands

| Command | Description |
|---|---|
| `claude-dedrift install` | Install the self-healing shim and patch the current binary |
| `claude-dedrift status` | Show version, patch state, and whether the shim is active |
| `claude-dedrift apply` | Patch the current binary now (used internally by the shim) |
| `claude-dedrift restore` | Revert the current binary to the original wrapper |
| `claude-dedrift uninstall` | Restore the binary and remove the shim + PATH entry |

Options: `--message "<text>"` (custom replacement, ≤147 bytes, printable ASCII),
`--target <path>`, `--quiet`.

## How it works

- The wrapper text is compiled into Claude Code's native single-file executable, so
  the only way to change it is an in-place byte edit. `claude-dedrift` overwrites the
  147-byte string with a same-length replacement and verifies the result by read-back.
- Auto-updates install a fresh binary and would discard the patch; the shim re-patches
  the new version on its first launch (tracked by a per-version marker) so you never
  notice.

See `CLAUDE.md` for the reverse-engineering details and internals.

## Safety

- No `sudo`: the binary lives under your home directory.
- Same-length patch: the executable's layout and size never change; `--version` keeps
  working. Verified against the real binary in the test flow.
- Reversible: `restore` writes the original text back (it's a known constant, so no
  large backup is kept), and `uninstall` fully undoes everything.

## Supported platforms

macOS and Linux. Windows is not supported yet.
