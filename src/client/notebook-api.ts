import { z } from 'zod';
import type { BrowserAuth } from './auth';
import { ApiError, authorizedFetch } from './api';
import type { NotebookCell, NotebookLanguage, NotebookSnapshot } from '../shared/notebook';
import { NOTEBOOK_CODE_BYTES, NOTEBOOK_OUTPUT_BYTES, notebookLanguage } from '../shared/notebook';

export interface NotebookApi {
  capabilities(project: string, signal: AbortSignal): Promise<{ enabled: boolean }>;
  list(project: string, signal: AbortSignal): Promise<NotebookSnapshot>;
  create(
    project: string,
    input: { language: NotebookLanguage; code: string },
    signal: AbortSignal,
  ): Promise<NotebookCell>;
  save(
    project: string,
    id: string,
    input: { version: number; code: string },
    signal: AbortSignal,
  ): Promise<NotebookCell>;
  execute(
    project: string,
    id: string,
    input: { version: number; files?: string[] },
    signal: AbortSignal,
  ): Promise<NotebookCell>;
  restart(
    project: string,
    language: NotebookLanguage,
    signal: AbortSignal,
  ): Promise<{ stateLost: boolean }>;
  artifact?(
    project: string,
    language: NotebookLanguage,
    name: string,
    signal: AbortSignal,
  ): Promise<void>;
}
const utf8 = (bytes: number) =>
  z.string().refine((value) => new TextEncoder().encode(value).length <= bytes);
const cellSchema = z.strictObject({
  id: z.uuid(),
  language: notebookLanguage,
  code: utf8(NOTEBOOK_CODE_BYTES),
  version: z.number().int().positive(),
  output: utf8(NOTEBOOK_OUTPUT_BYTES),
  executedBy: z.uuid().nullable(),
  stateLost: z.boolean(),
});

/** @id CODE-NB-007 @implements REQ-NB-002 */
export function createNotebookApi(auth: BrowserAuth): NotebookApi {
  async function request(
    project: string,
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
  ) {
    const response = await authorizedFetch(
      auth,
      `/api/projects/${encodeURIComponent(project)}/notebook${path}`,
      {
        method,
        signal,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      },
    );
    if (!response.ok)
      throw new ApiError(
        response.status,
        response.status === 409
          ? 'セルが変更されました。再読み込みしてください。'
          : response.status === 503
            ? 'Notebookは現在利用できません。'
            : 'Notebookの操作に失敗しました。',
      );
    const value: unknown = await response.json();
    signal.throwIfAborted();
    return value;
  }
  return {
    capabilities: async (project, signal) =>
      z
        .strictObject({ enabled: z.boolean() })
        .parse(await request(project, '/capabilities', 'GET', signal)),
    list: async (project, signal) =>
      z
        .strictObject({ cells: z.array(cellSchema).max(128) })
        .parse(await request(project, '', 'GET', signal)),
    create: async (project, input, signal) =>
      cellSchema.parse(await request(project, '/cells', 'POST', signal, input)),
    save: async (project, id, input, signal) =>
      cellSchema.parse(
        await request(project, `/cells/${encodeURIComponent(id)}`, 'PUT', signal, input),
      ),
    execute: async (project, id, input, signal) =>
      cellSchema.parse(
        await request(project, `/cells/${encodeURIComponent(id)}/execute`, 'POST', signal, input),
      ),
    restart: async (project, language, signal) =>
      z
        .strictObject({ stateLost: z.literal(true) })
        .parse(await request(project, '/restart', 'POST', signal, { language })),
    artifact: async (project, language, name, signal) => {
      await request(project, '/artifacts', 'POST', signal, { language, name });
    },
  };
}
