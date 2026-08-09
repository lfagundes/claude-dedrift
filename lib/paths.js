'use strict';

// Locating the real Claude Code binary and our own state, independent of PATH
// (so it keeps working even after our shim shadows `claude`).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STATE_DIR = path.join(os.homedir(), '.claude-dedrift');
const SHIM_DIR = path.join(STATE_DIR, 'bin');
const MARKER_DIR = path.join(STATE_DIR, 'patched');
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// Follow a symlink chain to the concrete file.
function resolveReal(p) {
  return fs.realpathSync(p);
}

// The `claude` command as the OS would run it WITHOUT our shim. We ignore any
// hit inside SHIM_DIR so we never resolve to ourselves.
function locateClaudeLink() {
  const cfg = readConfig();
  if (cfg.claudeLink && fs.existsSync(cfg.claudeLink)) return cfg.claudeLink;

  const candidates = [];
  try {
    const out = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
    if (out) candidates.push(out);
  } catch {
    /* not on PATH */
  }
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'));

  for (const c of candidates) {
    if (!c) continue;
    if (path.resolve(c).startsWith(SHIM_DIR + path.sep)) continue; // skip our shim
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Resolve to the actual versioned binary to patch.
function locateClaudeBinary() {
  const link = locateClaudeLink();
  return link ? resolveReal(link) : null;
}

module.exports = {
  STATE_DIR,
  SHIM_DIR,
  MARKER_DIR,
  CONFIG_PATH,
  readConfig,
  writeConfig,
  resolveReal,
  locateClaudeLink,
  locateClaudeBinary,
};
