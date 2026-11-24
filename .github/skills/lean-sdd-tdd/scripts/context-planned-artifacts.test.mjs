import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
const tag = name => '@' + name;

function fixture(t) {
  const parent = path.resolve('.sdd/check-output/context-planned-artifacts/fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  fs.mkdirSync(path.join(root, '.tool'));
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) {
    fs.copyFileSync(path.join(directory, name), path.join(root, '.tool', name));
  }
  const call = (args, tool = path.join(root, '.tool/sdd.mjs')) => {
    const result = spawnSync(process.execPath, [tool, '--root', root, ...args],
      { cwd: root, env: { ...environment, GIT_CEILING_DIRECTORIES: parent },
        encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error);
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const context = (...args) => call(['context', ...args]);
  const specification = '---\nfeature: future\ntier: T1\n---\n'
    + '| REQ-FIX-001 | When invoked, the marker shall return one. | TEST-FIX-001 |\n';
  write('.sdd/specs/future.md', specification);
  const code = value => `/** ${tag('id')} CODE-FIX-001 ${tag('implements')} REQ-FIX-001 */\nexport const marker = () => ${value};\n`;
  write('src/ready.mjs', code(0));
  write('tests/ready.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { marker } from '../src/ready.mjs';\n"
    + `/** ${tag('id')} TEST-FIX-001 ${tag('verifies')} REQ-FIX-001 */\n`
    + "test('TEST-FIX-001', () => assert.equal(marker(), 1));\n");
  write('.sdd/config.json', {
    planning: { required: true }, scan: { include: ['src/**', 'tests/**'] },
    testCmd: [process.execPath, '--test', '--test-name-pattern', '{id}', '{file}'],
    checks: [{ name: 'test', cmd: [process.execPath, '--test', 'tests/ready.test.mjs'] }],
  });
  const task = { id: 'future-task', feature: 'future', kind: 'implementation', reqs: ['REQ-FIX-001'],
    dependsOn: [], artifacts: ['src/ready.mjs', 'tests/ready.test.mjs', 'future/item.txt'],
    condition: 'The current marker returns one and every declared artifact is present.',
    tests: ['TEST-FIX-001'],
    checks: [{ name: 'marker', argv: [process.execPath, '--test', 'tests/ready.test.mjs'], timeoutMs: 20000 }],
    specs: { '.sdd/specs/future.md': hash(specification) }, dependencies: {}, status: 'blocked', receipt: null };
  const plan = { schemaVersion: 1, features: [{ id: 'future', dependsOn: [] }], tasks: [task] };
  const save = () => write('.sdd/implementation-plan.json', plan);
  save();
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, env: environment, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  return { root, write, call, context, task, plan, save, code, specification };
}
function accepted(result) {
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}
function refused(result) {
  assert.notEqual(result.code, 0, result.out + result.err);
  assert.doesNotMatch(result.out, /"text":|export const marker|When invoked, the marker/);
}
const missing = [{ path: 'future/item.txt', owners: ['future-task'] }];
function control(f) {
  const result = accepted(f.context('REQ-FIX-001', '--json'));
  assert.deepEqual(result.plannedMissing, missing);
  return result;
}

/** @id TEST-CTXPLAN-001 @verifies REQ-CTXPLAN-001 */
test('TEST-CTXPLAN-001 emits every existing file and canonical future path with all eligible owners and closure', t => {
  const f = fixture(t);
  for (const status of ['not-started', 'in-progress', 'blocked']) {
    f.task.status = status;
    f.save();
    const result = control(f);
    assert.deepEqual(result.files.map(file => file.path),
      ['.sdd/specs/future.md', 'src/ready.mjs', 'tests/ready.test.mjs']);
    for (const file of result.files) {
      const bytes = fs.readFileSync(path.join(f.root, file.path));
      assert.equal(file.text, bytes.toString('utf8'));
      assert.equal(file.sha256, hash(bytes));
      assert.equal(file.bytes, bytes.length);
    }
  }
  f.write('owned-data.txt', 'owned without source annotations\n');
  f.task.artifacts.push('owned-data.txt');
  f.save();
  const rootAlias = f.root + '-root-alias';
  fs.symlinkSync(f.root, rootAlias);
  t.after(() => fs.unlinkSync(rootAlias));
  const atRoot = (root, args) => {
    const result = spawnSync(process.execPath, [path.join(f.root, '.tool/sdd.mjs'), '--root', root, 'context', ...args],
      { cwd: f.root, env: { ...environment, GIT_CEILING_DIRECTORIES: path.dirname(f.root) },
        encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error);
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  for (const selector of ['REQ-FIX-001', '.sdd/specs/future.md', 'owned-data.txt', 'src/ready.mjs']) {
    for (const flags of [[], ['--json']]) {
      const actual = atRoot(rootAlias, [selector, ...flags]);
      assert.equal(actual.code, 0, actual.out + actual.err);
      assert.equal(actual.out, atRoot(f.root, [selector, ...flags]).out);
    }
  }
  const aliasContext = accepted(atRoot(rootAlias, ['REQ-FIX-001', '--json']));
  assert.deepEqual(aliasContext.plannedMissing, missing);
  assert.ok(aliasContext.features.every(feature => feature.paths.every(file => !file.split('/').includes('..'))));
  assert.equal(accepted(atRoot(rootAlias, [path.join(rootAlias, 'owned-data.txt'), '--json'])).files
    .find(file => file.path === 'owned-data.txt').text, 'owned without source annotations\n');
  refused(atRoot(rootAlias, ['future/item.txt', '--json']));
  fs.mkdirSync(path.join(f.root, 'future'));
  fs.symlinkSync('future', path.join(f.root, 'alias'));
  f.plan.tasks.push({ ...f.task, id: 'a-shared-owner', status: 'in-progress', artifacts: ['alias/item.txt'] });
  f.plan.tasks.push({ ...f.task, id: 'z-shared-owner', status: 'not-started', artifacts: ['future/item.txt'] });
  f.task.artifacts.push('future/other.txt');
  f.save();
  const result = accepted(f.context('REQ-FIX-001', '--json'));
  assert.deepEqual(result.plannedMissing, [
    { path: 'future/item.txt', owners: ['a-shared-owner', 'future-task', 'z-shared-owner'] },
    { path: 'future/other.txt', owners: ['future-task'] },
  ]);
  const downstream = '---\nfeature: downstream\ntier: T1\n---\n';
  f.write('.sdd/specs/downstream.md', downstream);
  f.plan.features.push({ id: 'downstream', dependsOn: ['future'] });
  f.save();
  assert.deepEqual(accepted(f.context('downstream', '--json')).features.map(row => row.feature), ['downstream', 'future']);
});

/** @id TEST-CTXPLAN-002 @verifies REQ-CTXPLAN-002 */
test('TEST-CTXPLAN-002 refuses required, direct, alias, shared, invalid-status and historical missing artifacts', t => {
  const f = fixture(t);
  control(f);
  for (const selector of ['future/item.txt', './future/item.txt']) refused(f.context(selector, '--json'));
  fs.mkdirSync(path.join(f.root, 'future'));
  fs.symlinkSync('future', path.join(f.root, 'alias'));
  refused(f.context('alias/item.txt', '--json'));
  const required = f.specification.replace('tier: T1', 'tier: T1\nartifacts: alias/item.txt');
  f.write('.sdd/specs/future.md', required);
  f.task.specs['.sdd/specs/future.md'] = hash(required);
  f.save();
  refused(f.context('REQ-FIX-001', '--json'));
  f.write('.sdd/specs/future.md', f.specification);
  f.task.specs['.sdd/specs/future.md'] = hash(f.specification);
  for (const status of ['complete', 'unknown', null]) {
    f.task.status = status;
    f.save();
    refused(f.context('REQ-FIX-001', '--json'));
  }
  f.task.status = 'blocked';
  f.task.receipt = '.sdd/absent-receipt.json';
  f.save();
  refused(f.context('REQ-FIX-001', '--json'));
  f.task.receipt = null;
  f.plan.features.push({ id: 'unselected', dependsOn: [] });
  f.write('.sdd/specs/unselected.md', '---\nfeature: unselected\ntier: T1\n---\n'
    + '| REQ-OTHER-001 | When called, return one. | TEST-FIX-001 |\n');
  f.plan.tasks.push({ ...f.task, id: 'unselected-owner', feature: 'unselected', reqs: ['REQ-OTHER-001'],
    artifacts: ['alias/item.txt'], specs: { '.sdd/specs/unselected.md': hash(fs.readFileSync(path.join(f.root, '.sdd/specs/unselected.md'))) },
    status: 'not-started' });
  f.save();
  assert.deepEqual(accepted(f.context('REQ-FIX-001', '--json')).plannedMissing,
    [{ path: 'future/item.txt', owners: ['future-task', 'unselected-owner'] }]);
  f.plan.tasks.at(-1).status = 'complete';
  f.save();
  refused(f.context('REQ-FIX-001', '--json'));
  f.plan.tasks.pop();
  f.plan.features.pop();
  fs.unlinkSync(path.join(f.root, '.sdd/specs/unselected.md'));
  f.save();
  control(f);
  const evidence = `.sdd/plan-evidence/${hash(f.task.id)}`;
  for (const kind of ['directory', 'file', 'dangling-symlink']) {
    if (kind === 'directory') fs.mkdirSync(path.join(f.root, evidence), { recursive: true });
    if (kind === 'file') f.write(evidence, 'history');
    if (kind === 'dangling-symlink') fs.symlinkSync('absent-history', path.join(f.root, evidence));
    refused(f.context('REQ-FIX-001', '--json'));
    fs.rmSync(path.join(f.root, evidence), { recursive: true, force: true });
    control(f);
  }
  fs.rmSync(path.join(f.root, '.sdd/plan-evidence'), { recursive: true, force: true });
  fs.symlinkSync('absent-history-root', path.join(f.root, '.sdd/plan-evidence'));
  refused(f.context('REQ-FIX-001', '--json'));
});

/** @id TEST-CTXPLAN-003 @verifies REQ-CTXPLAN-003 */
test('TEST-CTXPLAN-003 refuses unsafe ancestors and nonregular targets and accepts safe in-root future aliases', t => {
  const f = fixture(t);
  control(f);
  f.write('ordinary-file', 'not a directory');
  fs.mkdirSync(path.join(f.root, 'directory'));
  fs.symlinkSync('absent-target', path.join(f.root, 'dangling'));
  fs.symlinkSync('../outside-missing', path.join(f.root, 'outside'));
  const outside = f.root + '-outside';
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.root, 'escaping'));
  for (const artifact of ['../outside.txt', '/outside.txt', 'ordinary-file/child', 'directory', 'dangling/child', 'dangling',
    'outside/child', 'escaping/absent', 'future\\item.txt']) {
    f.task.artifacts = [artifact];
    f.save();
    refused(f.context('REQ-FIX-001', '--json'));
  }
  fs.symlinkSync('directory', path.join(f.root, 'safe'));
  f.task.artifacts = ['safe/future.txt'];
  f.save();
  assert.deepEqual(accepted(f.context('REQ-FIX-001', '--json')).plannedMissing,
    [{ path: 'directory/future.txt', owners: ['future-task'] }]);
  refused(f.context('directory', '--json'));
});

/** @id TEST-CTXPLAN-004 @verifies REQ-CTXPLAN-004 */
test('TEST-CTXPLAN-004 deterministically lists all missing owners in both formats with exact full UTF-8 limits and flags', t => {
  const f = fixture(t);
  control(f);
  f.task.artifacts.push('future/日本語.txt', 'future/a.txt');
  f.plan.tasks.push({ ...f.task, id: 'another-owner', status: 'not-started', artifacts: ['future/日本語.txt'] });
  f.save();
  const expected = [
    { path: 'future/a.txt', owners: ['future-task'] }, ...missing,
    { path: 'future/日本語.txt', owners: ['another-owner', 'future-task'] },
  ];
  assert.deepEqual(accepted(f.context('REQ-FIX-001', '--json')).plannedMissing, expected);
  for (const flags of [[], ['--json']]) {
    const result = f.context('REQ-FIX-001', ...flags);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(f.context('REQ-FIX-001', ...flags).out, result.out);
    assert.match(result.out, /not yet present/);
    for (const row of expected) {
      assert.ok(result.out.includes(row.path), result.out);
      for (const owner of row.owners) assert.ok(result.out.includes(owner), result.out);
    }
    const bytes = Buffer.byteLength(result.out);
    assert.equal(f.context('REQ-FIX-001', ...flags, '--max-bytes', String(bytes)).out, result.out);
    const overflow = f.context('REQ-FIX-001', ...flags, '--max-bytes', String(bytes - 1));
    refused(overflow);
    assert.match(overflow.out, new RegExp(`required=${bytes}\\b`));
  }
  for (const flags of [['--no-run'], ['--bogus'], ['--max-bytes', '0'], ['--max-bytes', '-1'],
    ['--max-bytes', '9007199254740992'], ['--max-bytes']]) refused(f.context('REQ-FIX-001', ...flags));
  f.write('future/item.txt', 'present now\n');
  assert.equal(accepted(f.context('REQ-FIX-001', '--json')).files.find(file => file.path === 'future/item.txt').text, 'present now\n');
  const large = '日本語\n'.repeat(131072);
  f.write('large.txt', large);
  f.task.artifacts.push('large.txt');
  f.save();
  assert.equal(accepted(f.context('REQ-FIX-001', '--json', '--max-bytes', '2000000'))
    .files.find(file => file.path === 'large.txt').text, large);
  const text = f.context('REQ-FIX-001', '--max-bytes', '2000000');
  assert.equal(text.code, 0, text.err);
  assert.ok(text.out.includes(large));
});

/** @id TEST-CTXPLAN-005 @verifies REQ-CTXPLAN-005 */
test('TEST-CTXPLAN-005 context is read-only, strict native verification and gates remain and helper identity invalidates receipts', t => {
  const f = fixture(t);
  const before = fs.readdirSync(path.join(f.root, '.sdd')).sort();
  control(f);
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.sdd')).sort(), before);
  assert.equal(fs.existsSync(path.join(f.root, '.sdd/tdd.jsonl')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.sdd/plan-evidence')), false);
  assert.notEqual(f.call(['gate']).code, 0);
  const missingVerification = f.call(['plan', 'verify', f.task.id, '--json']);
  assert.notEqual(missingVerification.code, 0);
  refused(f.context('REQ-FIX-001', '--json'));
  const g = fixture(t);
  g.write('future/item.txt', 'ready\n');
  assert.equal(g.call(['plan', 'check', '--json']).code, 0);
  const red = g.call(['tdd', 'red', 'TEST-FIX-001']);
  assert.equal(red.code, 0, red.out + red.err);
  assert.match(red.out, /RED ok/);
  g.write('src/ready.mjs', g.code(1));
  const green = g.call(['tdd', 'green', 'TEST-FIX-001']);
  assert.equal(green.code, 0, green.out + green.err);
  const verified = accepted(g.call(['plan', 'verify', g.task.id, '--json']));
  g.task.status = 'complete';
  g.task.receipt = verified.receipt;
  g.save();
  const receipt = fs.readFileSync(path.join(g.root, verified.receipt));
  const row = () => accepted(g.call(['plan', 'check', '--json'])).tasks.find(task => task.id === g.task.id);
  assert.equal(row().state, 'complete');
  fs.appendFileSync(path.join(g.root, '.tool/context-planned-artifacts.mjs'), '\n// isolated identity mutation\n');
  const changed = g.call(['plan', 'check', '--json']);
  assert.notEqual(JSON.parse(changed.out).tasks.find(task => task.id === g.task.id).state, 'complete');
  assert.deepEqual(fs.readFileSync(path.join(g.root, verified.receipt)), receipt);
  assert.notEqual(g.call(['gate']).code, 0);
});
