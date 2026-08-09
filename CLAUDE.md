# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This project is a **patcher for the Claude Code CLI binary**. It rewrites the
`<system-reminder>` wrapper that Claude Code injects around user-provided context
(CLAUDE.md, rules files, project instructions).

The stock wrapper tells the model the context *"may or may not be relevant"* and that
it *"should not respond to this context unless it is highly relevant."* That language
lets the agent silently discount standing instructions. The patcher replaces it with
wording that frames the context as **authoritative standing instructions to obey where
they apply to the current task**.

Design intent (deliberate): CLAUDE.md is loaded for *every* command, so by construction
part of it won't apply to a given task. The replacement must therefore say "obey the
parts that apply," not "everything here always applies" (which would force in irrelevant
context) and not the stock "ignore unless highly relevant" (which lets the agent drop
instructions the user is relying on). The goal is user control: a misfiring instruction
should be visible and fixable in the file, not silently discarded by the agent.

Update the concrete facts below whenever a new CLI version changes them.

## Commands

- `node bin/claude-dedrift.js <cmd>` — run the CLI from source (`install` | `status` | `apply` | `restore` | `uninstall`).
- `npm test` — run `test/patch.test.js` (patches a synthetic fixture; touches no real binary).
- Manual real-binary check without altering the install: `cp` the binary to a scratch path, then
  `node bin/claude-dedrift.js apply --target <copy>` / `status` / `restore`, and compare md5.

## Architecture

Three pieces:

- `lib/patch.js` — the byte engine. `findOffsets` streams the file in 4 MB chunks with
  `needle.length-1` overlap so matches spanning chunk boundaries are still found. `apply`/`restore`
  open the file `r+` and overwrite the 147 bytes in place (never changing length), then verify by
  read-back. The original text is a known constant, so `restore` needs no backup copy.
- `lib/paths.js` / `lib/install.js` — locate the real binary (following the `claude` symlink, never
  resolving to our own shim) and manage the self-healing shim + PATH entry.
- `bin/claude-dedrift.js` + `lib/shim.sh` — the CLI and the installed shim.

### Self-healing shim (the update-survival mechanism)

Claude Code auto-updates by dropping a new `versions/<v>` binary and moving the symlink, which
silently discards the patch. `install` writes a POSIX-`sh` shim to `~/.claude-dedrift/bin/claude`
and prepends that dir to PATH. On each `claude` launch the shim resolves the real binary, and if
`~/.claude-dedrift/patched/<version>` is missing it runs `claude-dedrift apply` once, drops the
marker, then `exec`s the real binary. After an update the version (marker name) changes, so the next
launch re-patches automatically. The shim must **never** block launch: if patching fails it warns and
`exec`s the unpatched binary anyway.

## What gets patched

The CLI is **not** a JS bundle you can edit — it is a single native executable with the
JavaScript embedded (Bun-style single-file executable):

- Installed binary (symlink target): `~/.local/share/claude/versions/<version>`
  (e.g. `2.1.210`), ~261 MB, ELF x86-64, not stripped.
- Active version is chosen by the symlink `~/.local/bin/claude -> versions/<version>`.
- **Every CLI update installs a new `versions/<version>` file**, so the patch must be
  re-applied after each upgrade. The patcher should target the current symlink target,
  not a hard-coded version.

The wrapper is produced by this function inside the binary (names are minified and change
between builds — match on the literal string, never on the function name `$Ku`):

```js
function $Ku(e,t){
  if(Object.entries(t).length===0)return e;
  return[Nr({content:`<system-reminder>
As you answer the user's questions, you can use the following context:
${Object.entries(t).map(([r,n])=>`# ${r}\n${n}`).join('\n')}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
`,isMeta:!0}),...e]
}
```

## The target string

Patch this exact 147-byte sentence (leading indentation is part of the template, not part
of the target — the target starts at `IMPORTANT:`):

```
IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
```

- Length: **147 bytes**.
- It appears **twice** in the binary (in 2.1.210, at byte offsets `125693128` and
  `245978788`). One copy is the readable JS source; the other lives in a compiled/snapshot
  region. **Both must be patched** — offsets shift between versions, so locate by string
  search, not by hard-coded offset.

## The critical constraint: same-length replacement

Do **not** change the byte length of the binary. It is a single-file executable with a
trailer/offset table and likely integrity metadata appended after the JS; inserting or
deleting bytes shifts those offsets and corrupts the executable.

The replacement must be **exactly 147 bytes**. Pad shorter wording with trailing spaces
(harmless inside the `<system-reminder>` block). The default replacement (`DEFAULT_MESSAGE`
in `lib/patch.js`, 139 bytes, space-padded to 147):

```
IMPORTANT: these are the user's authoritative standing instructions. Obey every one that applies to the current task; do not discount them.
```

## Patch invariants (how the implementation behaves)

1. Resolve the real binary via the `claude` symlink (`lib/paths.js`), never resolving to our shim.
2. Find **all** occurrences of the 147-byte target (expect 2; `apply` throws if 0 and the
   binary isn't already patched).
3. Overwrite each occurrence **in place** through an `r+` file descriptor — no temp file, no
   length change — then verify each write by reading the bytes back.
4. No full-binary backup is kept: the original text is a compile-time constant, so `restore`
   just writes it back at the patched offsets.
5. `apply` is idempotent — a binary already carrying the replacement is a no-op success.

Verify a patch by re-searching the binary: the target count should be 0 and the replacement
count should be 2, and `claude --version` should still run (proven in the test flow).
