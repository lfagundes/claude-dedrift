'use strict';

// Installs / removes the self-healing shim and its PATH entry.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  STATE_DIR,
  SHIM_DIR,
  MARKER_DIR,
  readConfig,
  writeConfig,
  resolveReal,
  locateClaudeLink,
} = require('./paths');

const BEGIN = '# >>> claude-dedrift >>>';
const END = '# <<< claude-dedrift <<<';

// Pick the shell rc file and the PATH-prepend snippet for it.
function shellProfile() {
  const shell = path.basename(process.env.SHELL || 'sh');
  const home = os.homedir();
  if (shell === 'zsh') {
    const zdot = process.env.ZDOTDIR || home;
    return { shell, rc: path.join(zdot, '.zshrc'), fish: false };
  }
  if (shell === 'bash') {
    return { shell, rc: path.join(home, '.bashrc'), fish: false };
  }
  if (shell === 'fish') {
    return { shell, rc: path.join(home, '.config', 'fish', 'config.fish'), fish: true };
  }
  return { shell, rc: path.join(home, '.profile'), fish: false };
}

function pathBlock(fish) {
  const line = fish
    ? `set -gx PATH ${SHIM_DIR} $PATH`
    : `export PATH="${SHIM_DIR}:$PATH"`;
  return `${BEGIN}\n${line}\n${END}\n`;
}

function hasBlock(contents) {
  return contents.includes(BEGIN);
}

function addPathEntry() {
  const { rc, fish } = shellProfile();
  fs.mkdirSync(path.dirname(rc), { recursive: true });
  let contents = '';
  try {
    contents = fs.readFileSync(rc, 'utf8');
  } catch {
    /* new file */
  }
  if (hasBlock(contents)) return { rc, added: false };
  const sep = contents && !contents.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(rc, contents + sep + '\n' + pathBlock(fish));
  return { rc, added: true };
}

function removePathEntry() {
  const { rc } = shellProfile();
  let contents;
  try {
    contents = fs.readFileSync(rc, 'utf8');
  } catch {
    return { rc, removed: false };
  }
  const re = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, 'g');
  if (!re.test(contents)) return { rc, removed: false };
  fs.writeFileSync(rc, contents.replace(re, '\n'));
  return { rc, removed: true };
}

function writeShim(claudeLink) {
  const template = fs.readFileSync(path.join(__dirname, 'shim.sh'), 'utf8');
  const shim = template
    .replace('@@CLAUDE_LINK@@', claudeLink)
    .replace('@@STATE_DIR@@', STATE_DIR);
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  const shimPath = path.join(SHIM_DIR, 'claude');
  fs.writeFileSync(shimPath, shim);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

// Resolve the real claude link, refusing to install if it already points at us.
function install() {
  const link = locateClaudeLink();
  if (!link) {
    throw new Error(
      'could not find the `claude` command. Install Claude Code first, or ensure it is on PATH.'
    );
  }
  const real = resolveReal(link);

  fs.mkdirSync(MARKER_DIR, { recursive: true });
  const shimPath = writeShim(link);
  const cfg = readConfig();
  cfg.claudeLink = link;
  cfg.installedAt = cfg.installedAt || null; // stamped by caller if desired
  writeConfig(cfg);

  const { rc, added } = addPathEntry();

  return { link, real, shimPath, rc, pathAdded: added };
}

function uninstall() {
  const { rc, removed } = removePathEntry();
  let shimRemoved = false;
  try {
    fs.rmSync(SHIM_DIR, { recursive: true, force: true });
    shimRemoved = true;
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(MARKER_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { rc, pathRemoved: removed, shimRemoved };
}

function clearMarkers() {
  try {
    fs.rmSync(MARKER_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  fs.mkdirSync(MARKER_DIR, { recursive: true });
}

module.exports = { install, uninstall, clearMarkers, shellProfile, STATE_DIR, SHIM_DIR };
