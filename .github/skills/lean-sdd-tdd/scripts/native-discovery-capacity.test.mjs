import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = process.env.SDD_SCRIPT_UNDER_TEST ?? fileURLToPath(new URL('./sdd.mjs', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-discovery-capacity-'));
const { NODE_TEST_CONTEXT, ...env } = process.env;
env.GIT_CEILING_DIRECTORIES = scratch;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, 'fixture-'));
  fs.mkdirSync(path.join(root, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdd/specs/a.md'), '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | When called, return1. | TEST-A-001 |\n');
  fs.writeFileSync(path.join(root, 'a.mjs'), '/** @id CODE-A-001 @implements REQ-A-001 */\nexport const answer = () => 0;\n');
  fs.writeFileSync(path.join(root, 'a.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './a.mjs';\n/** @id TEST-A-001 @verifies REQ-A-001 */\ntest('TEST-A-001', () => assert.equal(answer(), 1));\n");
  fs.writeFileSync(path.join(root, '.sdd/config.json'), JSON.stringify({
    planning: { required: false },
    scopePolicy: 'strict',
    scan: { include: ['a.mjs', 'a.test.mjs'] },
    testCmd: ['node', '--test', '--test-name-pattern', '{id}', '{file}'],
    checks: [{ name: 'test', cmd: ['node', '--test', 'a.test.mjs'] }],
  }));
  return root;
}

function directories(root, count) {
  const base = path.join(root, 'node_modules');
  fs.mkdirSync(base, { recursive: true });
  for (let i = 0; i < count; i++) fs.mkdirSync(path.join(base, `package-${i}`));
  const manifest = path.join(base, 'package-0/package.json');
  fs.writeFileSync(manifest, '{"name":"capacity-control","type":"commonjs"}\n');
  return manifest;
}

function run(root, ...args) {
  const result = spawnSync(process.execPath, [script, '--root', root, ...args], {
    encoding: 'utf8', env, timeout: 30000,
  });
  assert.equal(result.error, undefined, String(result.error));
  return { code: result.status, out: result.stdout + result.stderr };
}

/** @id TEST-NDC-001 @verifies REQ-NDC-001 */
test('TEST-NDC-001 retains package provenance beyond4096 directories and rejects passing Red', () => {
  const root = fixture();
  const manifest = directories(root, 5000);
  const red = run(root, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /AssertionError|ERR_ASSERTION/);
  fs.writeFileSync(path.join(root, 'a.mjs'), '/** @id CODE-A-001 @implements REQ-A-001 */\nexport const answer = () => 1;\n');
  const green = run(root, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  const ledger = path.join(root, '.sdd/tdd.jsonl');
  const before = fs.readFileSync(ledger, 'utf8');
  const evidence = JSON.parse(before.trim().split('\n').at(-1));
  assert.ok(Object.hasOwn(evidence.checkDefShas, 'resolution|node_modules/package-0/package.json'));
  const valid = run(root, 'gate');
  assert.equal(valid.code, 0, valid.out);
  const original = fs.readFileSync(manifest);
  fs.writeFileSync(manifest, '{"name":"capacity-control","type":"module"}\n');
  const invalid = run(root, 'gate');
  assert.equal(invalid.code, 1, invalid.out);
  assert.match(invalid.out, /node_modules\/package-0\/package\.json/);
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  fs.writeFileSync(manifest, original);
  const restored = run(root, 'gate');
  assert.equal(restored.code, 0, restored.out);
  const falseRed = run(root, 'tdd', 'red', 'TEST-A-001');
  assert.equal(falseRed.code, 1, falseRed.out);
  assert.match(falseRed.out, /test passed/);
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
});

/** @id TEST-NDC-002 @verifies REQ-NDC-002 */
test('TEST-NDC-002 refuses excess directories before execution and preserves prior evidence', () => {
  const root = fixture();
  const red = run(root, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  const ledger = path.join(root, '.sdd/tdd.jsonl');
  const before = fs.readFileSync(ledger);
  directories(root, 17000);
  fs.writeFileSync(path.join(root, 'a.test.mjs'), fs.readFileSync(path.join(root, 'a.test.mjs'), 'utf8') +
    "\nimport fs from 'node:fs';\nfs.writeFileSync('executed', 'unexpected');\n");
  const refused = run(root, 'tdd', 'red', 'TEST-A-001');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /REFUSED: check-definition discovery budget \(16384 directories\)/);
  assert.deepEqual(fs.readFileSync(ledger), before);
  assert.equal(fs.existsSync(path.join(root, 'executed')), false);
});
