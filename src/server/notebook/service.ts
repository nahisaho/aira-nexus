import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { Principal } from '../../shared/contracts.js';
import type { NotebookLanguage } from '../../shared/notebook.js';
import { NOTEBOOK_OUTPUT_BYTES, NOTEBOOK_STAGE_BYTES } from '../../shared/notebook.js';
import type { FileService } from '../files/service.js';
import { validateUpload } from '../files/service.js';
import type { NotebookKernel, NotebookRepository } from './repository.js';
import { NotebookError, notebookUnavailable } from './repository.js';

export interface NotebookInput {
  id: string;
  name: string;
  bytes: Uint8Array;
}
export interface NotebookDriver {
  ready(): Promise<void>;
  start(kernel: NotebookKernel, files: NotebookInput[]): Promise<void>;
  stop(kernel: NotebookKernel): Promise<void>;
  exists(kernel: NotebookKernel): Promise<boolean>;
  execute(kernel: NotebookKernel, code: string, signal: AbortSignal): Promise<string>;
  artifact(kernel: NotebookKernel, name: string): Promise<Uint8Array>;
}
export function startNotebookReclaimer(service: Pick<NotebookService, 'reclaim'>): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void service
      .reclaim()
      .catch(() => console.error(JSON.stringify({ event: 'notebook_reclaim_failed' })))
      .finally(() => {
        running = false;
      });
  }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}
export function boundedOutput(output: string) {
  const bytes = Buffer.from(output);
  if (bytes.length <= NOTEBOOK_OUTPUT_BYTES) return output;
  const suffix = '\n[output truncated]';
  return (
    new TextDecoder().decode(
      bytes.subarray(0, NOTEBOOK_OUTPUT_BYTES - Buffer.byteLength(suffix) - 3),
    ) + suffix
  );
}

/** @id CODE-NB-001 @implements REQ-NB-001 REQ-NB-002 REQ-NB-003 REQ-NB-004 REQ-NB-005 */
export class NotebookService {
  readonly handlers: ReadonlyMap<
    string,
    (
      owner: Principal,
      project: string,
      id: string,
      version: number,
      files: string[],
    ) => Promise<unknown>
  >;
  constructor(
    public readonly repository: NotebookRepository,
    public readonly runtime: NotebookDriver,
    private readonly files?: FileService,
  ) {
    this.handlers = new Map([['notebook.execute', this.execute.bind(this)]]);
  }
  private async stop(client: PoolClient, kernel: NotebookKernel) {
    await this.runtime.stop(kernel);
    await this.repository.removed(client, kernel);
  }
  private async inputs(owner: Principal, project: string, ids: string[]): Promise<NotebookInput[]> {
    if (!ids.length) return [];
    if (!this.files || new Set(ids).size !== ids.length)
      throw new NotebookError(400, 'Select available project file IDs.');
    let total = 0;
    const inputs: NotebookInput[] = [];
    for (const id of ids) {
      const source = await this.files.open(owner, project, id);
      total += source.file.size;
      if (total > NOTEBOOK_STAGE_BYTES) {
        await source.body.cancel();
        throw new NotebookError(413, 'Selected files exceed the staging limit.');
      }
      const reader = source.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const hash = createHash('sha256');
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > source.file.size) throw notebookUnavailable();
          hash.update(next.value);
          chunks.push(next.value);
        }
        if (size !== source.file.size || hash.digest('hex') !== source.file.sha256)
          throw notebookUnavailable();
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      inputs.push({ id, name: source.file.name, bytes: Buffer.concat(chunks) });
    }
    return inputs;
  }
  async execute(owner: Principal, project: string, id: string, version: number, ids: string[]) {
    return this.repository.locked(project, async (client) => {
      const cell = await this.repository.get(client, owner, project, id);
      if (cell.version !== version)
        throw new NotebookError(409, 'Cell changed. Reload before running.');
      try {
        await this.runtime.ready();
      } catch {
        throw notebookUnavailable();
      }
      const inputs = await this.inputs(owner, project, ids);
      const inputsHash = createHash('sha256')
        .update(
          JSON.stringify(
            inputs.map((f) => [f.id, createHash('sha256').update(f.bytes).digest('hex')]),
          ),
        )
        .digest('hex');
      let kernel = await this.repository.kernel(client, project, cell.language);
      if (
        kernel &&
        (kernel.inputsHash !== inputsHash ||
          kernel.state === 'executing' ||
          !(await this.runtime.exists(kernel)))
      ) {
        await this.stop(client, kernel);
        cell.stateLost = true;
        kernel = undefined;
      }
      if (!kernel) {
        kernel = await this.repository.reserve(client, owner, project, cell.language, inputsHash);
        try {
          await this.runtime.start(kernel, inputs);
        } catch {
          await this.stop(client, kernel);
          throw notebookUnavailable();
        }
      }
      await client.query(
        "UPDATE notebook_kernels SET state='executing',last_used_at=clock_timestamp() WHERE generation=$1",
        [kernel.generation],
      );
      let output: string;
      try {
        output = await this.runtime.execute(kernel, cell.code, AbortSignal.timeout(120000));
      } catch {
        await this.stop(client, kernel);
        cell.stateLost = true;
        output = '[execution interrupted; kernel stopped; variables lost]';
      }
      await client.query(
        "UPDATE notebook_kernels SET state='idle',last_used_at=clock_timestamp() WHERE generation=$1",
        [kernel.generation],
      );
      const result = await this.repository.result(client, owner, cell, boundedOutput(output));
      return { ...result, stateLost: result.stateLost || cell.stateLost };
    });
  }
  async restart(owner: Principal, project: string, language: NotebookLanguage) {
    return this.repository.locked(project, async (client) => {
      await this.repository.authorize(owner, project, client);
      const kernel = await this.repository.kernel(client, project, language);
      if (kernel) await this.stop(client, kernel);
      return { stateLost: true };
    });
  }
  async artifact(owner: Principal, project: string, language: NotebookLanguage, name: string) {
    if (name.trim() === '.' || name.trim() === '..')
      throw new NotebookError(400, 'Use an artifact basename.');
    const metadata = validateUpload({ name, size: 0 });
    return this.repository.locked(project, async (client) => {
      await this.repository.authorize(owner, project, client);
      if (!this.files) throw notebookUnavailable();
      const kernel = await this.repository.kernel(client, project, language);
      if (!kernel) throw new NotebookError(409, 'Start the kernel before saving an artifact.');
      const bytes = await this.runtime.artifact(kernel, metadata.name);
      return this.files.upload(
        owner,
        project,
        { name: metadata.name, size: bytes.byteLength },
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
    });
  }
  async trash<T>(owner: Principal, project: string, action: () => Promise<T>) {
    return this.repository.locked(project, async (client) => {
      await this.repository.authorize(owner, project, client);
      for (const language of ['python', 'r'] as const) {
        const kernel = await this.repository.kernel(client, project, language);
        if (kernel) await this.stop(client, kernel);
      }
      return action();
    });
  }
  async reclaim() {
    const { rows } = await this.repository.pool.query(
      `SELECT k.project_id FROM notebook_kernels k JOIN projects p ON p.id=k.project_id
       WHERE k.last_used_at<clock_timestamp()-interval '900 seconds'
          OR to_jsonb(p)->>'trashed_at' IS NOT NULL GROUP BY k.project_id`,
    );
    for (const row of rows)
      await this.repository.locked(row.project_id, async (client) => {
        for (const language of ['python', 'r'] as const) {
          const stale = await client.query(
            `SELECT k.generation FROM notebook_kernels k JOIN projects p ON p.id=k.project_id
           WHERE k.project_id=$1 AND k.language=$2 AND
           (k.last_used_at<clock_timestamp()-interval '900 seconds' OR to_jsonb(p)->>'trashed_at' IS NOT NULL)`,
            [row.project_id, language],
          );
          if (stale.rows.length) {
            const kernel = await this.repository.kernel(client, row.project_id, language);
            if (kernel) await this.stop(client, kernel);
          }
        }
      });
  }
}
