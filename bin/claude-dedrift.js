#!/usr/bin/env node
'use strict';

// claude-dedrift — patch the Claude Code binary so user-provided context
// (CLAUDE.md, rules) is always treated as relevant, and keep it patched across
// auto-updates via a self-healing shim.

const patch = require('../lib/patch');
const install = require('../lib/install');
const paths = require('../lib/paths');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--message' || a === '-m') opts.message = argv[++i];
    else if (a.startsWith('--target=')) opts.target = a.slice('--target='.length);
    else if (a.startsWith('--message=')) opts.message = a.slice('--message='.length);
    else opts._.push(a);
  }
  return opts;
}

function log(opts, ...args) {
  if (!opts.quiet) console.log(...args);
}

function die(msg) {
  console.error(`claude-dedrift: ${msg}`);
  process.exit(1);
}

// The message to apply: explicit flag > saved config > built-in default.
function resolveMessage(opts) {
  if (opts.message != null) return opts.message;
  const cfg = paths.readConfig();
  return cfg.message != null ? cfg.message : patch.DEFAULT_MESSAGE;
}

function targetFor(opts) {
  if (opts.target) return opts.target;
  const bin = paths.locateClaudeBinary();
  if (!bin) die('could not find the claude binary. Is Claude Code installed and on PATH?');
  return bin;
}

const commands = {
  apply(opts) {
    const target = targetFor(opts);
    const message = resolveMessage(opts);
    const r = patch.apply(target, { message });
    // remember the applied message so restore/status can find it later
    const cfg = paths.readConfig();
    if (opts.message != null) cfg.message = opts.message;
    paths.writeConfig(cfg);
    if (r.status === 'already-patched') log(opts, `already patched (${r.count}x): ${target}`);
    else log(opts, `patched ${r.count} occurrence(s): ${target}`);
  },

  restore(opts) {
    const target = targetFor(opts);
    const message = resolveMessage(opts);
    const r = patch.restore(target, { message });
    if (r.status === 'already-original') log(opts, `already original: ${target}`);
    else log(opts, `restored ${r.count} occurrence(s): ${target}`);
  },

  status(opts) {
    const link = paths.locateClaudeLink();
    if (!link) die('could not find the claude command.');
    const target = opts.target || paths.resolveReal(link);
    const message = resolveMessage(opts);
    const s = patch.status(target, { message });
    const shimPath = path.join(install.SHIM_DIR, 'claude');
    const shimInstalled = fs.existsSync(shimPath);
    const onPath = (process.env.PATH || '')
      .split(path.delimiter)
      .some((p) => path.resolve(p) === path.resolve(install.SHIM_DIR));

    console.log(`claude command : ${link}`);
    console.log(`real binary    : ${target}`);
    console.log(`version        : ${path.basename(target)}`);
    console.log(`patch state    : ${s.state} (original=${s.original}, patched=${s.patched})`);
    console.log(`shim installed : ${shimInstalled ? 'yes' : 'no'} (${install.SHIM_DIR})`);
    console.log(`shim on PATH   : ${onPath ? 'yes' : 'no'}`);
    if (shimInstalled && !onPath) {
      console.log('  -> restart your shell (or source your rc file) to activate the shim.');
    }
  },

  install(opts) {
    const r = install.install();
    // persist a custom message so the shim reuses it on every auto-update re-patch
    if (opts.message != null) {
      const cfg = paths.readConfig();
      cfg.message = opts.message;
      paths.writeConfig(cfg);
    }
    // patch the current version right away and drop its marker
    const message = resolveMessage(opts);
    let patched;
    try {
      patched = patch.apply(r.real, { message });
      install.clearMarkers();
      fs.mkdirSync(paths.MARKER_DIR, { recursive: true });
      fs.writeFileSync(path.join(paths.MARKER_DIR, path.basename(r.real)), '');
    } catch (e) {
      console.error(`claude-dedrift: initial patch failed: ${e.message}`);
    }
    console.log('claude-dedrift installed.');
    console.log(`  shim         : ${r.shimPath}`);
    console.log(`  claude       : ${r.link}`);
    console.log(`  binary       : ${r.real}`);
    if (patched) console.log(`  patched      : ${patched.count} occurrence(s)`);
    if (r.pathAdded) {
      console.log(`  PATH updated : ${r.rc}`);
      console.log('\nRestart your shell (or `source` the file above) to activate it.');
    } else {
      console.log(`  PATH         : already present in ${r.rc}`);
    }
  },

  uninstall(opts) {
    // restore the current binary before tearing down, best-effort
    try {
      const bin = paths.locateClaudeBinary();
      if (bin) patch.restore(bin, { message: resolveMessage(opts) });
    } catch (e) {
      console.error(`claude-dedrift: could not restore binary: ${e.message}`);
    }
    const r = install.uninstall();
    console.log('claude-dedrift uninstalled.');
    if (r.pathRemoved) console.log(`  PATH entry removed from ${r.rc}`);
    if (r.shimRemoved) console.log(`  shim removed from ${install.SHIM_DIR}`);
    console.log('Restart your shell to drop the shim from PATH.');
  },

  help() {
    console.log(`claude-dedrift — keep Claude Code honoring your CLAUDE.md/context

Usage:
  claude-dedrift install       Install the self-healing shim and patch now
  claude-dedrift status        Show the current patch / shim state
  claude-dedrift apply         Patch the current binary now
  claude-dedrift restore       Revert the current binary to the original
  claude-dedrift uninstall     Restore the binary and remove the shim

Options:
  --target <path>   Operate on a specific binary (used by the shim)
  --message <text>  Replacement text (<=147 bytes, printable ASCII)
  --quiet, -q       Suppress normal output
  --force, -f       Reserved for future use

The shim self-heals after every Claude Code auto-update, so you normally only
run \`install\` once.`);
  },
};

function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._[0] || 'help';
  const fn = commands[cmd] || commands[({ '-h': 'help', '--help': 'help' })[cmd]] || null;
  if (!fn) {
    console.error(`claude-dedrift: unknown command "${cmd}"\n`);
    commands.help();
    process.exit(1);
  }
  try {
    fn(opts);
  } catch (e) {
    die(e.message);
  }
}

main();
