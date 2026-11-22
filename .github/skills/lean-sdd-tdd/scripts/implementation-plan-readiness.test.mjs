import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tag = name => '@' + name;
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;

function fixture(t, locked = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-native-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tool = path.join(root, '.tool');
  fs.mkdirSync(tool);
  for (const name of fs.readdirSync(directory).filter(name =>
    name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) {
    fs.copyFileSync(path.join(directory, name), path.join(tool, name));
  }
  const write = (relative, value) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), typeof value === 'string' || Buffer.isBuffer(value)
      ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const call = (args, expected = 0, json = true) => {
    const result = spawnSync(process.execPath, [path.join(tool, 'sdd.mjs'), ...args,
      ...(json ? ['--json'] : []), '--root', root],
    { cwd: root, env: environment, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  const code = (first, extra = null) => `/** ${tag('id')} CODE-FIX-001 ${tag('implements')} REQ-FIX-001 */\nexport const marker=()=>${first};\n`
    + (extra === null ? '' : `/** ${tag('id')} CODE-FIX-002 ${tag('implements')} REQ-FIX-002 */\nexport const extra=()=>${extra};\n`);
  const tests = extended => "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + `import {${extended ? 'marker,extra' : 'marker'}} from '../src/marker.mjs';\n`
    + `/** ${tag('id')} TEST-FIX-001 ${tag('verifies')} REQ-FIX-001 */\ntest('TEST-FIX-001',()=>assert.equal(marker(),1));\n`
    + (extended ? `/** ${tag('id')} TEST-FIX-002 ${tag('verifies')} REQ-FIX-002 */\ntest('TEST-FIX-002',()=>assert.equal(extra(),2));\n` : '');
  const originalSpec = '---\nfeature: probe\ntier: T1\n---\n'
    + '| REQ-FIX-001 | When invoked, the first marker shall return 1. | TEST-FIX-001 |\n';
  const nextSpec = `---\nfeature: probe\ntier: ${locked ? 'T2' : 'T1'}\napproval: auto\n---\n`
    + '| REQ-FIX-001 | When invoked, the first marker shall return 1. | TEST-FIX-001 |\n'
    + '| REQ-FIX-002 | When invoked, the extra marker shall return 2. | TEST-FIX-002 |\n'
    + '## Design\nThe isolated fixture exposes two numeric marker functions.\n'
    + 'Only actual local Node checks establish fixture proof; no application completion is inferred.\n';
  write('.sdd/specs/probe.md', originalSpec);
  write('src/marker.mjs', code(0));
  write('tests/marker.test.mjs', tests(false));
  write('completion.md', 'first-ready\n');
  write('.sdd/config.json', {
    testCmd: [process.execPath, '--test', '--test-name-pattern', '{id}', '{file}'],
    checks: [{ name: 'test', cmd: [process.execPath, '--test', 'tests/marker.test.mjs'] }],
    scan: { include: ['src/**', 'tests/**'] }, planning: { required: true },
  });
  const task = { id: 'probe', feature: 'probe', kind: 'implementation', reqs: ['REQ-FIX-001'],
    dependsOn: [], artifacts: ['src/marker.mjs', 'tests/marker.test.mjs', 'completion.md'],
    condition: 'The first numeric marker and current completion marker pass actual checks.',
    tests: ['TEST-FIX-001'],
    checks: [{ name: 'actual-markers', argv: [process.execPath, '--test', 'tests/marker.test.mjs'], timeoutMs: 20000 },
      { name: 'actual-completion', argv: [process.execPath, '--input-type=module', '-e',
        "import fs from 'node:fs';if(!fs.readFileSync('completion.md','utf8').includes('first-ready'))process.exit(1);"],
      timeoutMs: 20000 }],
    specs: { '.sdd/specs/probe.md': digest(originalSpec) }, dependencies: {}, status: 'not-started', receipt: null };
  const document = { schemaVersion: 1, features: [{ id: 'probe', dependsOn: [] }], tasks: [task] };
  const save = () => write('.sdd/implementation-plan.json', document);
  save();
  call(['tdd', 'red', 'TEST-FIX-001'], 0, false);
  write('src/marker.mjs', code(1));
  call(['tdd', 'green', 'TEST-FIX-001'], 0, false);
  const original = call(['plan', 'verify', 'probe']);
  task.receipt = original.receipt;
  task.status = 'complete';
  save();
  assert.equal(call(['plan', 'check']).tasks[0].state, 'complete');
  write('.sdd/specs/probe.md', nextSpec);
  write('src/marker.mjs', code(1, 0));
  write('tests/marker.test.mjs', tests(true));
  task.reqs.push('REQ-FIX-002');
  task.tests.push('TEST-FIX-002');
  task.specs['.sdd/specs/probe.md'] = digest(nextSpec);
  task.condition = 'Both numeric markers and the second completion marker pass actual current checks.';
  task.checks[1].argv[3] =
    "import fs from 'node:fs';if(!fs.readFileSync('completion.md','utf8').includes('second-ready'))process.exit(1);";
  task.status = 'in-progress';
  save();
  if (locked) {
    call(['approve', 'prepare', 'probe'], 0, false);
    call(['approve', 'record', 'probe', '--by', 'ai:isolated-integration-fixture', '--review',
      'Synthetic fixture lock admission only; not a product or implementation approval.'], 0, false);
  }
  call(['tdd', 'red', 'TEST-FIX-002'], 0, false);
  return { root, tool, call, write, task, save, code, original };
}

function retained(f) {
  const result = new Map();
  const directory = path.join(f.root, '.sdd/plan-evidence');
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else result.set(path.relative(f.root, file), fs.readFileSync(file));
    }
  };
  visit(directory);
  return result;
}

function assertRetained(f, before) {
  for (const [relative, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.root, relative)), bytes);
}

/** @id TEST-NPR-002 @verifies REQ-NPR-002 */
test('TEST-NPR-002 actual Native missing/stale verification permits planning only with intact current inputs', t => {
  const f = fixture(t);
  const before = retained(f);
  const result = f.call(['plan', 'check'], 0);
  assert.equal(result.exit, 0, 'TEST-NPR-002 current-known pending replanning must be accepted for planning only');
  assert.equal(result.tasks[0].state, 'replan-required');
  assert.match(result.tasks[0].fingerprint, /^[a-f0-9]{64}$/);
  f.call(['gate'], 1, false);
  assertRetained(f, before);
  for (const status of ['not-started', 'in-progress', 'blocked']) {
    f.task.status = status;
    f.save();
    assert.equal(f.call(['plan', 'check']).tasks[0].state, 'replan-required');
  }
});

/** @id TEST-NPR-003 @verifies REQ-NPR-003 REQ-NPR-002 */
test('TEST-NPR-003 historically attempted invalid Native inputs and stale complete claims retain refusal', t => {
  const f = fixture(t);
  const refuse = reason => {
    const result = f.call(['plan', 'check'], 1);
    assert.equal(result.exit, 1);
    if (reason) assert(result.tasks[0].reasons.some(value => value.includes(reason)), JSON.stringify(result));
  };
  f.task.status = 'complete';
  f.save();
  refuse('needs replanning');
  f.task.status = 'in-progress';
  f.task.receipt = null;
  f.save();
  refuse('authored receipt must name the current history head');
  f.task.receipt = f.original.receipt;
  f.save();
  const specHash = f.task.specs['.sdd/specs/probe.md'];
  f.task.specs['.sdd/specs/probe.md'] = '0'.repeat(64);
  f.save();
  refuse('needs replanning');
  f.task.specs['.sdd/specs/probe.md'] = specHash;
  f.save();
  const receipt = path.join(f.root, f.original.receipt);
  const originalBytes = fs.readFileSync(receipt);
  const log = JSON.parse(originalBytes).checks[0].log.path;
  for (const [relative, reason] of [[f.original.receipt, 'receipt bytes differ from their digest'],
    [log, 'retained log bytes changed']]) {
    const file = path.join(f.root, relative), bytes = fs.readFileSync(file);
    try { fs.appendFileSync(file, ' '); refuse(reason); }
    finally { fs.writeFileSync(file, bytes); }
  }
  for (const relative of ['.sdd/approvals.json', 'tests/marker.test.mjs', 'completion.md', '.sdd/tdd.jsonl']) {
    const file = path.join(f.root, relative), bytes = fs.readFileSync(file);
    try { fs.unlinkSync(file); refuse(); }
    finally { fs.writeFileSync(file, bytes); }
  }
  const unlocked = fixture(t, false);
  const unlockedHistory = retained(unlocked);
  unlocked.call(['plan', 'check']);
  const refuseUnlocked = () => unlocked.call(['plan', 'check'], 1);
  const ledger = path.join(unlocked.root, '.sdd/tdd.jsonl'), ledgerBytes = fs.readFileSync(ledger);
  try {
    fs.unlinkSync(ledger);
    refuseUnlocked();
  } finally { fs.writeFileSync(ledger, ledgerBytes); }
  try {
    fs.writeFileSync(ledger, '');
    refuseUnlocked();
  } finally { fs.writeFileSync(ledger, ledgerBytes); }
  try {
    fs.writeFileSync(ledger, ledgerBytes.toString().split('\n')[0] + '\n');
    refuseUnlocked();
  } finally { fs.writeFileSync(ledger, ledgerBytes); }
  try {
    const lines = ledgerBytes.toString().trimEnd().split('\n');
    const event = JSON.parse(lines[0]);
    event.hash = '0'.repeat(64);
    lines[0] = JSON.stringify(event);
    fs.writeFileSync(ledger, lines.join('\n') + '\n');
    refuseUnlocked();
  } finally { fs.writeFileSync(ledger, ledgerBytes); }
  assert.deepEqual(fs.readFileSync(receipt), originalBytes);
  assertRetained(unlocked, unlockedHistory);
});

/** @id TEST-NPR-004 @verifies REQ-NPR-004 */
test('TEST-NPR-004 actual failed verification and adoption never substitute for current successful Native completion', t => {
  const f = fixture(t);
  const before = retained(f);
  f.write('src/marker.mjs', f.code(1, 2));
  f.call(['tdd', 'green', 'TEST-FIX-002'], 0, false);
  f.call(['tdd', 'refactor', 'TEST-FIX-001'], 0, false);
  const failed = f.call(['plan', 'verify', 'probe'], 1);
  const failedReceipt = JSON.parse(fs.readFileSync(path.join(f.root, failed.receipt)));
  assert.equal(failedReceipt.checks.at(-1).name, 'actual-completion');
  assert.equal(failedReceipt.checks.at(-1).exit, 1);
  const withFailure = retained(f);
  const unadopted = f.call(['plan', 'check'], 1);
  assert(unadopted.tasks[0].reasons.includes('authored receipt must name the current history head'));
  f.task.receipt = failed.receipt;
  f.save();
  const pending = f.call(['plan', 'check']);
  assert.equal(pending.exit, 0, 'TEST-NPR-004 adopted failed head may permit planning but must never establish completion');
  assert.equal(pending.tasks[0].state, 'revalidation-required');
  assert(pending.tasks[0].reasons.includes('latest verification did not pass'));
  f.call(['gate'], 1, false);
  f.write('completion.md', 'second-ready\n');
  const success = f.call(['plan', 'verify', 'probe']);
  f.task.receipt = success.receipt;
  f.task.status = 'complete';
  f.save();
  assert.equal(f.call(['plan', 'check']).tasks[0].state, 'complete');
  f.call(['gate'], 0, false);
  assertRetained(f, before);
  assertRetained(f, withFailure);
});
