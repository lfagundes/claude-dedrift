'use strict';

// Core byte-patching for the Claude Code native binary.
//
// The binary embeds this exact 147-byte sentence (twice) inside the function
// that wraps user context in a <system-reminder>. We replace it in place with a
// same-length string so the executable's layout/offsets never shift.

const fs = require('fs');

const TARGET = Buffer.from(
  'IMPORTANT: this context may or may not be relevant to your tasks. ' +
    'You should not respond to this context unless it is highly relevant to your task.',
  'latin1'
);

const TARGET_LEN = TARGET.length; // 147

const DEFAULT_MESSAGE =
  "IMPORTANT: these are the user's authoritative standing instructions. " +
  'Obey every one that applies to the current task; do not discount them.';

// Build the same-length (147-byte) replacement buffer from a message.
// Shorter messages are right-padded with spaces; longer ones are rejected.
function makeReplacement(message) {
  const msg = (message == null ? DEFAULT_MESSAGE : String(message)).trim();
  if (!/^[\x20-\x7e]*$/.test(msg)) {
    throw new Error('message must be printable ASCII (no newlines/tabs/unicode)');
  }
  if (msg.includes('`') || msg.includes('\\') || msg.includes('${')) {
    throw new Error('message must not contain ` \\ or ${ (would break the embedded template)');
  }
  if (Buffer.byteLength(msg, 'latin1') > TARGET_LEN) {
    throw new Error(
      `message is ${Buffer.byteLength(msg, 'latin1')} bytes; must be <= ${TARGET_LEN}`
    );
  }
  const buf = Buffer.alloc(TARGET_LEN, 0x20); // fill with spaces
  buf.write(msg, 0, 'latin1');
  return buf;
}

// Stream the whole file and return every byte offset where `needle` occurs.
function findOffsets(fd, needle) {
  const size = fs.fstatSync(fd).size;
  const overlap = needle.length - 1;
  const CHUNK = 4 * 1024 * 1024;
  const buf = Buffer.alloc(overlap + CHUNK);
  const offsets = [];
  let carry = 0; // valid bytes already in buf[0..carry) (tail of previous read)
  let absBufStart = 0; // file offset that buf[0] corresponds to
  let filePos = 0; // next file read position

  while (filePos < size || carry > 0) {
    let bytesRead = 0;
    if (filePos < size) {
      bytesRead = fs.readSync(fd, buf, carry, CHUNK, filePos);
      filePos += bytesRead;
    }
    const total = carry + bytesRead;
    if (total === 0) break;

    let from = 0;
    for (;;) {
      const idx = buf.indexOf(needle, from);
      if (idx === -1 || idx + needle.length > total) break;
      offsets.push(absBufStart + idx);
      from = idx + 1;
    }

    if (bytesRead === 0) break; // searched the final tail; nothing left to read
    const keep = Math.min(overlap, total);
    buf.copy(buf, 0, total - keep, total);
    absBufStart += total - keep;
    carry = keep;
  }

  return [...new Set(offsets)].sort((a, b) => a - b);
}

function readAt(fd, offset, len) {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, offset);
  return b;
}

// Open `target`, translating common failure modes into messages that name the
// actual cause instead of a raw errno (ETXTBSY reads like "missing file" otherwise).
function openTarget(target, flags) {
  try {
    return fs.openSync(target, flags);
  } catch (e) {
    if (e.code === 'ETXTBSY') {
      throw new Error(
        `${target} is currently running (another Claude Code session has it open) — ` +
          'close other Claude Code sessions/terminals using this binary and try again'
      );
    }
    if (e.code === 'ENOENT') {
      throw new Error(`${target} does not exist — Claude Code may have moved; try "claude-dedrift install" again`);
    }
    if (e.code === 'EACCES') {
      throw new Error(`permission denied opening ${target}`);
    }
    throw e;
  }
}

// Patch `target` in place. Idempotent: a binary already carrying `repl` is a
// no-op. Throws if the wrapper string can't be found at all (unknown version).
function apply(target, { message } = {}) {
  const repl = makeReplacement(message);
  const fd = openTarget(target, 'r+');
  try {
    const targetOffsets = findOffsets(fd, TARGET);
    if (targetOffsets.length === 0) {
      const already = findOffsets(fd, repl);
      if (already.length > 0) {
        return { status: 'already-patched', count: already.length };
      }
      throw new Error(
        'wrapper string not found — this Claude Code version is unsupported ' +
          '(the embedded text may have changed)'
      );
    }
    for (const off of targetOffsets) {
      fs.writeSync(fd, repl, 0, repl.length, off);
    }
    for (const off of targetOffsets) {
      if (!readAt(fd, off, repl.length).equals(repl)) {
        throw new Error(`write verification failed at offset ${off}`);
      }
    }
    return { status: 'patched', count: targetOffsets.length };
  } finally {
    fs.closeSync(fd);
  }
}

// Revert `target` to the original wrapper. `message` must match what was applied
// (defaults to the built-in message) so we can locate the bytes to overwrite.
function restore(target, { message } = {}) {
  const repl = makeReplacement(message);
  const fd = openTarget(target, 'r+');
  try {
    const replOffsets = findOffsets(fd, repl);
    if (replOffsets.length === 0) {
      const orig = findOffsets(fd, TARGET);
      if (orig.length > 0) return { status: 'already-original', count: orig.length };
      throw new Error('could not find the patched text to restore (message mismatch?)');
    }
    for (const off of replOffsets) {
      fs.writeSync(fd, TARGET, 0, TARGET.length, off);
    }
    for (const off of replOffsets) {
      if (!readAt(fd, off, TARGET.length).equals(TARGET)) {
        throw new Error(`restore verification failed at offset ${off}`);
      }
    }
    return { status: 'restored', count: replOffsets.length };
  } finally {
    fs.closeSync(fd);
  }
}

// Report whether `target` is patched, without modifying it.
function status(target, { message } = {}) {
  const repl = makeReplacement(message);
  const fd = openTarget(target, 'r');
  try {
    const original = findOffsets(fd, TARGET).length;
    const patched = findOffsets(fd, repl).length;
    let state = 'unknown';
    if (original > 0 && patched === 0) state = 'original';
    else if (patched > 0 && original === 0) state = 'patched';
    else if (patched > 0 && original > 0) state = 'mixed';
    return { state, original, patched };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  TARGET,
  TARGET_LEN,
  DEFAULT_MESSAGE,
  makeReplacement,
  findOffsets,
  apply,
  restore,
  status,
};
