'use strict';

// Exercises the byte-patcher against a synthetic binary-like fixture that
// contains the target string twice, surrounded by arbitrary bytes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const patch = require('../lib/patch');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

function makeFixture() {
  const junkA = Buffer.alloc(1000, 0x00);
  const junkB = Buffer.from('function $Ku(e,t){return`<system-reminder>\n');
  const junkC = Buffer.alloc(5_000_003, 0xff); // odd size to cross chunk boundaries
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-')),
    'fake-claude'
  );
  fs.writeFileSync(
    file,
    Buffer.concat([junkA, patch.TARGET, junkB, junkC, patch.TARGET, junkA])
  );
  return file;
}

test('target constant is 147 bytes', () => {
  assert.strictEqual(patch.TARGET_LEN, 147);
});

test('default replacement is exactly 147 bytes and space-padded', () => {
  const r = patch.makeReplacement();
  assert.strictEqual(r.length, 147);
  assert.ok(r.toString('latin1').startsWith("IMPORTANT: these are the user's authoritative"));
});

test('custom message padded; over-long rejected', () => {
  assert.strictEqual(patch.makeReplacement('hi').length, 147);
  assert.throws(() => patch.makeReplacement('x'.repeat(148)), /147/);
  assert.throws(() => patch.makeReplacement('bad`tick'), /backtick|`/i);
  assert.throws(() => patch.makeReplacement('line\nbreak'), /ASCII/);
});

test('finds both occurrences across chunk boundaries', () => {
  const file = makeFixture();
  const fd = fs.openSync(file, 'r');
  assert.strictEqual(patch.findOffsets(fd, patch.TARGET).length, 2);
  fs.closeSync(fd);
});

test('apply patches both, is idempotent, keeps file size', () => {
  const file = makeFixture();
  const before = fs.statSync(file).size;
  let r = patch.apply(file);
  assert.strictEqual(r.status, 'patched');
  assert.strictEqual(r.count, 2);
  assert.strictEqual(fs.statSync(file).size, before);

  r = patch.apply(file);
  assert.strictEqual(r.status, 'already-patched');

  const s = patch.status(file);
  assert.strictEqual(s.state, 'patched');
  assert.strictEqual(s.patched, 2);
  assert.strictEqual(s.original, 0);
});

test('restore returns the binary to original bytes', () => {
  const file = makeFixture();
  const original = fs.readFileSync(file);
  patch.apply(file);
  assert.ok(!fs.readFileSync(file).equals(original));
  const r = patch.restore(file);
  assert.strictEqual(r.status, 'restored');
  assert.strictEqual(r.count, 2);
  assert.ok(fs.readFileSync(file).equals(original), 'restored bytes match original');
});

test('apply on unknown binary throws', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-')), 'x');
  fs.writeFileSync(file, Buffer.alloc(2048, 0x41));
  assert.throws(() => patch.apply(file), /unsupported|not found/i);
});

console.log(`\n${passed} tests passed`);
