import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeLedgerReadBudget, readNativeLedgerBytes, readNativeLedgerEntries, parseNativeLedgerChunks, assertNativeLedgerAppend } from './native-ledger.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-ledger-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tool = path.join(root, '.tool');
  fs.mkdirSync(tool);
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) {
    fs.copyFileSync(path.join(directory, name), path.join(tool, name));
  }
  const write = (name, data) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  const call = (args, exit = 0, script = path.join(tool, 'sdd.mjs'), json = true) => {
    const result = spawnSync(process.execPath, [script, ...args, ...(json ? ['--json'] : []), '--root', root],
      { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  const spec = '---\nfeature: probe\ntier: T1\n---\n| REQ-PROBE-001 | When read, the document shall contain ready. (test-only) | TEST-PROBE-001 |\n';
  write('.sdd/specs/probe.md', spec);
  write('probe.md', 'ready\n');
  const tag = name => '@' + name;
  write('probe.test.mjs', `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n/** ${tag('id')} TEST-PROBE-001 ${tag('verifies')} REQ-PROBE-001 */\ntest('TEST-PROBE-001',()=>assert.match(fs.readFileSync('probe.md','utf8'),/ready/));\n`);
  const config = { testCmd: [process.execPath, '--test', '{file}'],
    checks: [{ name: 'test', cmd: [process.execPath, '--test', 'probe.test.mjs'] }],
    scan: { include: ['probe.test.mjs', 'probe.md'] }, planning: { required: true } };
  const document = { schemaVersion: 1, features: [{ id: 'probe', dependsOn: [] }],
    tasks: [{ id: 'probe', feature: 'probe', kind: 'implementation', reqs: ['REQ-PROBE-001'], dependsOn: [],
      artifacts: ['probe.md'], condition: 'Document contains ready.', tests: ['TEST-PROBE-001'],
      checks: [{ name: 'probe', argv: [process.execPath, '--test', 'probe.test.mjs'], timeoutMs: 20000 }],
      specs: { '.sdd/specs/probe.md': digest(spec) }, dependencies: {}, status: 'not-started', receipt: null }] };
  const configure = () => write('.sdd/config.json', config);
  configure();
  write('.sdd/implementation-plan.json', document);
  for (const stage of ['red', 'green']) call(['tdd', stage, 'TEST-PROBE-001'], 0, undefined, false);
  const adopt = () => {
    const verified = call(['plan', 'verify', 'probe']);
    assert.equal(verified.status, 'PASS');
    document.tasks[0].status = 'complete';
    document.tasks[0].receipt = verified.receipt;
    write('.sdd/implementation-plan.json', document);
    return verified;
  };
  adopt();
  return { root, tool, call, write, config, configure, adopt };
}
function growLedger(f, target = 511 * 1024 * 1024) {
  const ledger = path.join(f.root, '.sdd/tdd.jsonl');
  let size = fs.statSync(ledger).size;
  const tail = Buffer.alloc(Math.min(size, 131072));
  const fd = fs.openSync(ledger, 'r');
  try { assert.equal(fs.readSync(fd, tail, 0, tail.length, size - tail.length), tail.length); }
  finally { fs.closeSync(fd); }
  const last = JSON.parse(tail.toString('utf8').trimEnd().split('\n').at(-1));
  let prev = last.hash, seq = last.seq;
  const at = new Date().toISOString();
  while (size < target) {
    const event = { v: 1, at, type: 'approval', feature: 'synthetic-capacity-only',
      approvalSha: '1'.repeat(64), padding: '', seq: ++seq, prev };
    const overhead = Buffer.byteLength(JSON.stringify({ ...event, hash: '0'.repeat(64) }) + '\n');
    const remaining = target - size;
    const padding = remaining > 65536 + 2 * overhead ? 65536 : remaining - overhead;
    assert.ok(padding >= 0);
    event.padding = 'x'.repeat(padding);
    event.hash = digest(JSON.stringify(event));
    const bytes = JSON.stringify(event) + '\n';
    fs.appendFileSync(ledger, bytes);
    size += Buffer.byteLength(bytes);
    prev = event.hash;
  }
  assert.equal(fs.statSync(ledger).size, target);
}

/** @id TEST-NLR-001 @verifies REQ-NLR-001 */
test('TEST-NLR-001 explicit bounded capacity validates policy and supports real native commands', t => {
  assert.equal(nativeLedgerReadBudget({}), 67108864);
  assert.doesNotThrow(() => assert.equal(nativeLedgerReadBudget({ nativeLedgerMaxBytes: 536870912 }), 536870912));
  assert.equal(nativeLedgerReadBudget({ nativeLedgerMaxBytes: 1e3 }), 1000);
  for (const value of [true, NaN, '1', 0, -1, 1.5, null, [], {}, 536870913]) {
    assert.throws(() => nativeLedgerReadBudget({ nativeLedgerMaxBytes: value }), /nativeLedgerMaxBytes/);
  }
  const f = fixture(t);
  assert.equal(f.call(['plan', 'check']).status, 'PASS');
  for (const value of [true, '1', 0, 1.5, null, 536870913]) {
    f.config.planning.nativeLedgerMaxBytes = value;
    f.configure();
    assert.equal(f.call(['plan', 'check'], 1).status, 'FAIL');
  }
  f.config.planning.nativeLedgerMaxBytes = 1000;
  f.configure();
  assert.match(JSON.stringify(f.call(['plan', 'check'], 1).errors), /verification inputs changed/);
  const standalone = path.join(f.root, 'standalone.mjs');
  fs.copyFileSync(path.join(f.tool, 'sdd.mjs'), standalone);
  f.config.planning.nativeLedgerMaxBytes = 536870913;
  f.configure();
  assert.equal(f.call(['plan', 'check'], 1, standalone).status, 'FAIL');
  f.config.planning.nativeLedgerMaxBytes = 536870912;
  f.configure();
  assert.equal(f.call(['plan', 'check'], 2, standalone).status, 'INCOMPLETE');
  f.config.planning.required = false;
  f.config.planning.nativeLedgerMaxBytes = 'invalid-but-disabled';
  f.configure();
  assert.equal(f.call(['plan', 'check']).status, 'DISABLED');
  assert.match(JSON.stringify(f.call(['plan', 'check'], 2, standalone).errors), /Planning modules unavailable/);
  f.config.planning = { required: true };
  f.configure();
  growLedger(f);
  const ledger = path.join(f.root, '.sdd/tdd.jsonl');
  const before = digest(fs.readFileSync(ledger));
  assert.equal(f.call(['plan', 'check'], 2).status, 'INCOMPLETE');
  assert.equal(digest(fs.readFileSync(ledger)), before);
  const legacy = fixture(t);
  legacy.config.planning.nativeLedgerMaxBytes = 268435456;
  legacy.configure();
  legacy.adopt();
  growLedger(legacy, 257 * 1024 * 1024);
  const oldLedger = path.join(legacy.root, '.sdd/tdd.jsonl');
  const oldHash = digest(fs.readFileSync(oldLedger));
  assert.equal(legacy.call(['plan', 'check'], 2).status, 'INCOMPLETE');
  assert.equal(digest(fs.readFileSync(oldLedger)), oldHash);
  f.config.planning.nativeLedgerMaxBytes = 536870912;
  f.configure();
  f.adopt();
  const accepted = digest(fs.readFileSync(ledger));
  assert.equal(f.call(['plan', 'check']).status, 'PASS');
  assert.equal(digest(fs.readFileSync(ledger)), accepted);
  growLedger(f, 512 * 1024 * 1024);
  const exactBoundary = digest(fs.readFileSync(ledger));
  assert.equal(f.call(['plan', 'check']).status, 'PASS');
  assert.equal(f.call(['gate']).verdict, 'PASS');
  assert.equal(digest(fs.readFileSync(ledger)), exactBoundary);
});

/** @id TEST-NLR-002 @verifies REQ-NLR-002 */
test('TEST-NLR-002 actual byte bounds survive growth while full-history rejection remains fail closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-ledger-bounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'ledger');
  fs.writeFileSync(file, Buffer.alloc(16, 97));
  let fd = fs.openSync(file, 'r');
  try { assert.deepEqual(readNativeLedgerBytes(fd, 16), Buffer.alloc(16, 97)); }
  finally { fs.closeSync(fd); }
  fs.writeFileSync(file, Buffer.alloc(32, 97));
  fd = fs.openSync(file, 'r');
  const stat = fs.fstatSync, read = fs.readSync;
  let readBytes = 0;
  mock.method(fs, 'fstatSync', value => ({ ...stat(value), size: 1 }));
  mock.method(fs, 'readSync', (...args) => { const count = read(...args); readBytes += count; return count; });
  try {
    assert.throws(() => readNativeLedgerBytes(fd, 16), /exceeds read budget/);
    assert.equal(readBytes, 17);
  } finally { mock.restoreAll(); fs.closeSync(fd); }
  assert.equal(fs.statSync(file).size, 32);
  fs.writeFileSync(file, '{}\n'.repeat(10));
  fd = fs.openSync(file, 'r');
  readBytes = 0;
  mock.method(fs, 'fstatSync', value => ({ ...stat(value), size: 1 }));
  mock.method(fs, 'readSync', (...args) => { const count = read(...args); readBytes += count; return count; });
  try {
    assert.throws(() => readNativeLedgerEntries(fd, 16), { code: 'ERR_NATIVE_LEDGER_BUDGET' });
    assert.equal(readBytes, 17);
  } finally { mock.restoreAll(); fs.closeSync(fd); }

  const f = fixture(t), ledger = path.join(f.root, '.sdd/tdd.jsonl');
  const original = fs.readFileSync(ledger);
  assert.equal(f.call(['plan', 'check']).status, 'PASS');
  for (const invalid of [Buffer.from([255]), Buffer.from('{'), Buffer.concat([original, Buffer.from('{\n')])]) {
    fs.writeFileSync(ledger, invalid);
    assert.equal(f.call(['plan', 'check'], 2).status, 'INCOMPLETE');
    assert.deepEqual(fs.readFileSync(ledger), invalid);
  }
  const lines = original.toString('utf8').trimEnd().split('\n');
  const first = JSON.parse(lines[0]);
  first.fileSha = '0'.repeat(64);
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(ledger, lines.join('\n') + '\n');
  assert.equal(f.call(['plan', 'check'], 1).status, 'FAIL');
  fs.writeFileSync(ledger, original);
  assert.equal(f.call(['plan', 'check']).status, 'PASS');
});

/** @id TEST-NLR-003 @verifies REQ-NLR-003 */
test('TEST-NLR-003 native helper and evidence-module edits invalidate receipts, restored bytes remain current', t => {
  const f = fixture(t);
  const baseline = f.call(['plan', 'check']).tasks[0];
  assert.equal(baseline.state, 'complete');
  assert.equal(f.call(['plan', 'check']).tasks[0].fingerprint, baseline.fingerprint);
  for (const name of ['native-ledger.mjs', 'implementation-plan-evidence.mjs', 'implementation-plan-readiness.mjs']) {
    const file = path.join(f.tool, name), original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// Isolated tool identity mutation.\n');
    const changed = f.call(['plan', 'check'], 1).tasks[0];
    assert.notEqual(changed.fingerprint, baseline.fingerprint);
    assert.equal(changed.state, 'revalidation-required');
    fs.writeFileSync(file, original);
    const restored = f.call(['plan', 'check']).tasks[0];
    assert.equal(restored.fingerprint, baseline.fingerprint);
    assert.equal(restored.state, 'complete');
  }
});

/** @id TEST-NLR-004 @verifies REQ-NLR-004 */
test('TEST-NLR-004 chunked callers preserve Unicode/BOM/history and bound Git and legacy merge', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-streaming-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input');
  const value = { padding: 'x'.repeat(65523) + '\u65e5\u672c\u8a9e' };
  fs.writeFileSync(input, JSON.stringify(value) + '\r\n\n{"tail":true}');
  const read = (bom = true) => {
    const fd = fs.openSync(input, 'r');
    try { return readNativeLedgerEntries(fd, 536870912, bom); }
    finally { fs.closeSync(fd); }
  };
  const requested = [], readSync = fs.readSync;
  mock.method(fs, 'readSync', (...args) => { requested.push(args[3]); return readSync(...args); });
  try {
    assert.doesNotThrow(() => assert.deepEqual(read(), [value, { tail: true }]));
    assert.ok(requested.length >= 2 && requested.every(bytes => bytes <= 65536));
  } finally { mock.restoreAll(); }
  fs.writeFileSync(input, '\ufeff{}\n');
  assert.deepEqual(read(), [{}]);
  assert.throws(() => read(false));
  fs.writeFileSync(input, '{}\n\ufeff{}\n');
  assert.throws(() => read());
  assert.deepEqual(parseNativeLedgerChunks([Buffer.from('{}\n')], 536870912), [{}]);
  assert.throws(() => parseNativeLedgerChunks([Buffer.from([255])], 536870912));
  const small = fixture(t);
  const smallLedger = path.join(small.root, '.sdd/tdd.jsonl');
  const smallBefore = fs.readFileSync(smallLedger);
  small.call(['tdd', 'merge-ledger'], 0, undefined, false);
  assert.deepEqual(fs.readFileSync(smallLedger), smallBefore);
  const standalone = path.join(small.root, 'standalone.mjs');
  fs.copyFileSync(path.join(small.tool, 'sdd.mjs'), standalone);
  assert.match(small.call(['tdd', 'check'], 2, standalone, false), /module unavailable/);
  const noFinalNewline = smallBefore.subarray(0, -1);
  fs.writeFileSync(smallLedger, noFinalNewline);
  small.config.planning.nativeLedgerMaxBytes = noFinalNewline.length;
  small.configure();
  small.call(['tdd', 'merge-ledger'], 2, undefined, false);
  assert.deepEqual(fs.readFileSync(smallLedger), noFinalNewline);
  small.config.planning.nativeLedgerMaxBytes++;
  small.configure();
  small.call(['tdd', 'merge-ledger'], 0, undefined, false);
  assert.deepEqual(fs.readFileSync(smallLedger), smallBefore);
  const bin = path.join(small.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
if (process.argv[2] === 'show') process.stdout.write(Buffer.alloc(131072, 120));
else { const result = spawnSync('/usr/bin/git', process.argv.slice(2), { stdio: 'inherit' }); process.exit(result.status ?? 2); }
`, { mode: 0o755 });
  small.config.planning.nativeLedgerMaxBytes = 65536;
  small.configure();
  const oldPath = env.PATH;
  env.PATH = bin + path.delimiter + oldPath;
  try {
    assert.match(small.call(['tdd', 'refactor', 'TEST-PROBE-001'], 2, undefined, false), /ENOBUFS/);
    assert.deepEqual(fs.readFileSync(smallLedger), smallBefore);
    assert.equal(fs.existsSync(path.join(small.root, '.sdd/tdd.lock')), false);
  } finally { env.PATH = oldPath; }
  fs.writeFileSync(input, JSON.stringify({ padding: 'x'.repeat(67108864 - 14) }));
  assert.equal(read()[0].padding.length, 67108864 - 14);
  fs.appendFileSync(input, ' ');
  assert.throws(() => read(), { code: 'ERR_NATIVE_LEDGER_RECORD_BUDGET' });
  const f = fixture(t);
  f.config.planning.nativeLedgerMaxBytes = 536870912;
  f.configure();
  f.adopt();
  const git = args => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', timeout: 90000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  growLedger(f, 65 * 1024 * 1024);
  git(['add', '.sdd/tdd.jsonl']);
  git(['-c', 'user.name=Ledger fixture', '-c', 'user.email=ledger-fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic history baseline']);
  growLedger(f, 511 * 1024 * 1024);
  f.adopt();
  growLedger(f, 512 * 1024 * 1024);
  git(['add', '.sdd/tdd.jsonl']);
  git(['-c', 'user.name=Ledger fixture', '-c', 'user.email=ledger-fixture@example.invalid',
    'commit', '--quiet', '-m', 'Exact512MiB synthetic baseline']);
  const ledger = path.join(f.root, '.sdd/tdd.jsonl');
  const original = digest(fs.readFileSync(ledger));
  assert.equal(f.call(['plan', 'check']).status, 'PASS');
  assert.equal(f.call(['gate']).verdict, 'PASS');
  f.call(['tdd', 'merge-ledger'], 2, undefined, false);
  assert.equal(digest(fs.readFileSync(ledger)), original);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
if (process.argv[2] === 'show') process.stderr.write(Buffer.alloc(536870912, 120), () => process.exit(1));
else { const result = spawnSync('/usr/bin/git', process.argv.slice(2), { stdio: 'inherit' }); process.exit(result.status ?? 2); }
`, { mode: 0o755 });
  env.PATH = bin + path.delimiter + oldPath;
  try {
    assert.match(f.call(['tdd', 'check'], 2, undefined, false), /Cannot read baseline ledger/);
    assert.equal(digest(fs.readFileSync(ledger)), original);
  } finally { env.PATH = oldPath; }
});

/** @id TEST-NLR-005 @verifies REQ-NLR-005 */
test('TEST-NLR-005 append preflight prevents overrun, preserves evidence and releases its lock', t => {
  assert.doesNotThrow(() => assertNativeLedgerAppend({ nativeLedgerMaxBytes: 8 }, 4, '"x"\n'));
  assert.throws(() => assertNativeLedgerAppend({ nativeLedgerMaxBytes: 7 }, 4, '"x"\n'),
    { code: 'ERR_NATIVE_LEDGER_BUDGET' });
  const record = JSON.stringify({ padding: 'x'.repeat(67108864 - 14) }) + '\n';
  assert.doesNotThrow(() => assertNativeLedgerAppend({ nativeLedgerMaxBytes: 536870912 }, 0, record));
  assert.throws(() => assertNativeLedgerAppend({ nativeLedgerMaxBytes: 536870912 }, 0,
    record.slice(0, -3) + 'x"}\n'), { code: 'ERR_NATIVE_LEDGER_RECORD_BUDGET' });
  const f = fixture(t), ledger = path.join(f.root, '.sdd/tdd.jsonl');
  const original = fs.readFileSync(ledger);
  const last = JSON.parse(original.toString('utf8').trimEnd().split('\n').at(-1));
  const event = { v: 1, seq: last.seq + 1, type: 'approval', feature: 'probe',
    approvalSha: '0'.repeat(64), at: '2000-01-01T00:00:00.000Z', prev: last.hash, hash: '0'.repeat(64) };
  const bytes = Buffer.byteLength(JSON.stringify(event) + '\n');
  const approval = ['approve', 'record', 'probe', '--by', 'ai:capacity-fixture', '--review', 'Synthetic capacity control'];
  const oldApproval = fs.existsSync(path.join(f.root, '.sdd/approvals.json'))
    ? fs.readFileSync(path.join(f.root, '.sdd/approvals.json')) : null;
  f.config.planning.nativeLedgerMaxBytes = original.length + bytes - 1;
  f.configure();
  const refused = f.call(approval, 2, undefined, false);
  assert.doesNotMatch(refused, /recorded probe|locked probe/);
  assert.deepEqual(fs.readFileSync(ledger), original);
  assert.equal(fs.existsSync(path.join(f.root, '.sdd/tdd.lock')), false);
  if (oldApproval === null) assert.equal(fs.existsSync(path.join(f.root, '.sdd/approvals.json')), false);
  else assert.deepEqual(fs.readFileSync(path.join(f.root, '.sdd/approvals.json')), oldApproval);
  f.config.planning.nativeLedgerMaxBytes = original.length + bytes;
  f.configure();
  f.call(approval, 0, undefined, false);
  assert.equal(fs.statSync(ledger).size, original.length + bytes);
  assert.deepEqual(fs.readFileSync(ledger).subarray(0, original.length), original);
  assert.equal(fs.existsSync(path.join(f.root, '.sdd/tdd.lock')), false);
  const full = fs.readFileSync(ledger);
  assert.match(f.call(['tdd', 'refactor', 'TEST-PROBE-001'], 2, undefined, false), /budget/i);
  assert.deepEqual(fs.readFileSync(ledger), full);
  assert.equal(fs.existsSync(path.join(f.root, '.sdd/tdd.lock')), false);
  const checked = f.call(['plan', 'verify', 'probe'], 2);
  assert.notEqual(checked.status, 'PASS');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, checked.receipt), 'utf8'));
  assert.notEqual(receipt.status, 'PASS');
  assert.deepEqual(fs.readFileSync(ledger), full);
  assert.equal(fs.existsSync(path.join(f.root, '.sdd/tdd.lock')), false);
});
