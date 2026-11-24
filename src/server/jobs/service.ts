import { z } from 'zod';
import type { Principal } from '../../shared/contracts.js';
import type { Job, JobClaim, JsonValue } from '../../shared/jobs.js';
import type { JobRepository } from './repository.js';
import { JobError } from './errors.js';

export interface JobCompletion {
  settle(outcome: { event: 'success' | 'error'; interrupted: boolean }): Promise<Job | null>;
}
export class JobExecutionUnconfirmed extends Error {
  constructor() {
    super('Job execution could not be confirmed stopped.');
  }
}
export interface JobHandler {
  input: z.ZodType;
  run(context: {
    claim: JobClaim;
    input: unknown;
    signal: AbortSignal;
  }): Promise<void | JobCompletion>;
}
export type JobHandlers = ReadonlyMap<string, JobHandler>;
const invalid = () =>
  new JobError(
    400,
    'INVALID_JOB',
    'Provide a registered job type, valid input and Idempotency-Key.',
  );
/** @id CODE-SVC-011 @implements REQ-SVC-011 */
export function canonicalJobInput(input: unknown): string {
  const ancestors = new Set<object>();
  const encode = (value: unknown, depth: number): string => {
    if (depth > 128) throw invalid();
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
      return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        throw invalid();
      return JSON.stringify(value);
    }
    if (typeof value !== 'object' || ancestors.has(value)) throw invalid();
    ancestors.add(value);
    try {
      if (Array.isArray(value))
        return '[' + value.map((item) => encode(item, depth + 1)).join(',') + ']';
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        throw invalid();
      const object = value as Record<string, unknown>;
      return (
        '{' +
        Object.keys(object)
          .sort()
          .map((key) => {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid();
            return JSON.stringify(key) + ':' + encode(object[key], depth + 1);
          })
          .join(',') +
        '}'
      );
    } finally {
      ancestors.delete(value);
    }
  };
  return encode(input, 0);
}
const jobInput = z.strictObject({ type: z.string().min(1).max(64), input: z.unknown() });
/** @id CODE-SVC-012 @implements REQ-SVC-010 REQ-SVC-011 REQ-SVC-014 */
export class JobService {
  constructor(
    public readonly repository: JobRepository,
    public readonly handlers: JobHandlers,
  ) {}
  async enqueue(owner: Principal, project: string, key: string | undefined, body: unknown) {
    await this.repository.authorize(owner, project);
    const parsed = jobInput.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.type === 'document.convert' ||
      parsed.data.type === 'chat.generate' ||
      parsed.data.type === 'notebook.execute' ||
      !Object.hasOwn(parsed.data, 'input') ||
      !key ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(key)
    )
      throw invalid();
    const handler = this.handlers.get(parsed.data.type);
    if (!handler || !handler.input.safeParse(parsed.data.input).success) throw invalid();
    const canonical = canonicalJobInput(parsed.data.input);
    if (Buffer.byteLength(canonical) > 16384) throw invalid();
    const input: JsonValue = JSON.parse(canonical);
    return this.repository.enqueue(owner, project, key, parsed.data.type, input);
  }
}
