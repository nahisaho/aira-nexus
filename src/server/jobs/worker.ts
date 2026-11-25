import { setTimeout as wait } from 'node:timers/promises';
import type { JobRepository } from './repository.js';
import { JobExecutionUnconfirmed } from './service.js';
import type { JobCompletion, JobHandlers } from './service.js';

/** @id CODE-SVC-014 @implements REQ-SVC-014 */
export function jobsEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.JOBS_ENABLED === undefined || env.JOBS_ENABLED === 'false') return false;
  if (env.JOBS_ENABLED === 'true') return true;
  throw new Error('Invalid job configuration.');
}
export const productionJobHandlers: JobHandlers = new Map();
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await wait(ms, undefined, { signal });
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error;
  }
}
/** @id CODE-SVC-015 @implements REQ-SVC-003 REQ-SVC-013 REQ-SVC-014 */
export class JobWorker {
  private busy = false;
  constructor(
    private readonly repository: JobRepository,
    private readonly handlers: JobHandlers,
    private readonly options: {
      heartbeatMs?: number;
      pollMs?: number;
      beforeClaim?: () => Promise<void>;
    } = {},
  ) {}
  async runOne(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.busy) throw new Error('Job worker is already executing.');
    this.busy = true;
    try {
      await this.options.beforeClaim?.();
      if (signal?.aborted) return false;
      const claim = await this.repository.claim([...this.handlers.keys()]);
      if (!claim) return false;
      const controller = new AbortController();
      const pulse = new AbortController();
      let shuttingDown = false;
      let heartbeatLost = false;
      const stop = () => {
        shuttingDown = true;
        controller.abort();
      };
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      const heartbeat = (async () => {
        while (!pulse.signal.aborted) {
          await pause(this.options.heartbeatMs ?? 5000, pulse.signal);
          if (pulse.signal.aborted) break;
          try {
            const state = await this.repository.heartbeat(claim);
            if (state === 'cancel_requested') controller.abort();
            if (state === null) {
              heartbeatLost = true;
              controller.abort();
              break;
            }
          } catch {
            heartbeatLost = true;
            console.error(JSON.stringify({ event: 'job_heartbeat_failed', jobId: claim.job.id }));
            controller.abort();
            break;
          }
        }
      })();
      let outcome: 'success' | 'error' = 'success';
      let code: 'handler_failed' | 'interrupted' | 'invalid_input' = 'handler_failed';
      let completion: JobCompletion | void = undefined;
      try {
        const handler = this.handlers.get(claim.job.type);
        const parsed = handler?.input.safeParse(claim.input);
        if (!handler || !parsed?.success) {
          outcome = 'error';
          code = 'invalid_input';
        } else
          completion = await handler.run({ claim, input: parsed.data, signal: controller.signal });
      } catch (error) {
        if (error instanceof JobExecutionUnconfirmed) throw error;
        outcome = 'error';
        console.error(JSON.stringify({ event: 'job_handler_failed', jobId: claim.job.id }));
      } finally {
        pulse.abort();
        await heartbeat;
        signal?.removeEventListener('abort', stop);
      }
      if (shuttingDown || heartbeatLost) {
        outcome = 'error';
        code = 'interrupted';
      }
      const finished = completion
        ? await completion.settle({ event: outcome, interrupted: shuttingDown || heartbeatLost })
        : await this.repository.finish(claim, outcome, code);
      if (!finished)
        console.error(JSON.stringify({ event: 'job_completion_fenced', jobId: claim.job.id }));
      return true;
    } finally {
      this.busy = false;
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    if (this.handlers.size === 0) throw new Error('No job handlers are registered.');
    while (!signal.aborted) {
      if (!(await this.runOne(signal))) await pause(this.options.pollMs ?? 1000, signal);
    }
  }
}
