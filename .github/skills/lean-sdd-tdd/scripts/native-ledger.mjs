import fs from 'node:fs';
import { createHash } from 'node:crypto';

const recordLimit = 67108864;
const problem = (code, message) => Object.assign(new Error(message), { code, exit: 2 });
const oversized = () => problem('ERR_NATIVE_LEDGER_BUDGET', 'Native ledger exceeds read budget');

/** @id CODE-NLR-001 @implements REQ-NLR-001 REQ-NLR-002 REQ-NLR-003 */
export function nativeLedgerReadBudget(planning = {}) {
  const invalid = message => Object.assign(new TypeError(message), { code: 'ERR_NATIVE_LEDGER_POLICY', exit: 1 });
  if (!planning || typeof planning !== 'object' || Array.isArray(planning)
    || Object.keys(planning).some(key => !['required', 'features', 'nativeLedgerMaxBytes'].includes(key))
    || Object.hasOwn(planning, 'required') && typeof planning.required !== 'boolean') {
    throw invalid('Invalid or unknown planning policy field');
  }
  if (Object.hasOwn(planning, 'features') && (!Array.isArray(planning.features) || !planning.features.length
    || !planning.features.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))
    || new Set(planning.features).size !== planning.features.length)) throw invalid('Invalid planning features');
  const limit = Object.hasOwn(planning, 'nativeLedgerMaxBytes') ? planning.nativeLedgerMaxBytes : 67108864;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 536870912) {
    throw invalid('planning.nativeLedgerMaxBytes must be an integer in1..536870912');
  }
  return limit;
}

function* ledgerChunks(fd, limit) {
  nativeLedgerReadBudget({ nativeLedgerMaxBytes: limit });
  if (fs.fstatSync(fd).size > limit) throw oversized();
  let length = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(65536, limit + 1 - length));
    const count = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (!count) return;
    length += count;
    if (length > limit) throw oversized();
    yield chunk.subarray(0, count);
  }
}

export function readNativeLedgerBytes(fd, limit = 67108864) {
  return Buffer.concat([...ledgerChunks(fd, limit)]);
}

/** @id CODE-NLR-004 @implements REQ-NLR-004 */
export function parseNativeLedgerChunks(chunks, limit = 67108864, allowLeadingBOM = true) {
  nativeLedgerReadBudget({ nativeLedgerMaxBytes: limit });
  const entries = [];
  let total = 0, recordBytes = 0, line = 1, parts = [];
  function append(bytes) {
    recordBytes += bytes.length;
    if (recordBytes > recordLimit)
      throw problem('ERR_NATIVE_LEDGER_RECORD_BUDGET', `Native ledger record ${line} exceeds read budget`);
    if (bytes.length) parts.push(bytes);
  }
  function finish() {
    if (recordBytes) {
      try {
        const text = new TextDecoder('utf-8', {
          fatal: true, ignoreBOM: !(allowLeadingBOM && line === 1),
        }).decode(Buffer.concat(parts, recordBytes));
        if (/^(<{7}|={7}|>{7})/.test(text))
          throw problem('ERR_NATIVE_LEDGER_CONFLICT', `Native ledger conflict at line ${line}`);
        if (text) entries.push(JSON.parse(text));
      } catch (error) {
        if (error.code?.startsWith('ERR_NATIVE_LEDGER_')) throw error;
        if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
        throw problem('ERR_NATIVE_LEDGER_INPUT', `Native ledger line ${line} is not valid UTF-8/JSON`);
      }
    }
    parts = [];
    recordBytes = 0;
    line++;
  }
  for (const chunk of chunks) {
    total += chunk.length;
    if (total > limit) throw oversized();
    let start = 0;
    for (let end; (end = chunk.indexOf(10, start)) >= 0;) {
      append(chunk.subarray(start, end));
      finish();
      start = end + 1;
    }
    append(chunk.subarray(start));
  }
  finish();
  return entries;
}

/** @id CODE-NLR-006 @implements REQ-NLR-002 REQ-NLR-004 */
export function readNativeLedgerEntries(fd, limit = 67108864, allowLeadingBOM = true) {
  return parseNativeLedgerChunks(ledgerChunks(fd, limit), limit, allowLeadingBOM);
}

/** @id CODE-NLR-007 @implements REQ-NLR-004 */
export function hashNativeLedgerFile(file, limit = 67108864) {
  const fd = fs.openSync(file, 'r');
  try {
    const hash = createHash('sha256');
    for (const chunk of ledgerChunks(fd, limit)) hash.update(chunk);
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/** @id CODE-NLR-005 @implements REQ-NLR-005 */
export function assertNativeLedgerAppend(planning, currentBytes, serialized) {
  const limit = nativeLedgerReadBudget(planning);
  const bytes = Buffer.byteLength(serialized);
  if (bytes - 1 > recordLimit)
    throw problem('ERR_NATIVE_LEDGER_RECORD_BUDGET', 'Native ledger append exceeds record budget');
  if (bytes > limit - currentBytes) throw oversized();
}
