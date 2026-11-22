import type { FilePage, ProjectFile } from '../shared/files';
import type { BrowserAuth } from './auth';
import { ApiError, authorizedFetch } from './api';
import { projectFileSchema, filePageSchema, MAX_FILE_BYTES } from '../shared/files';
export interface FilesApi {
  list(
    projectId: string,
    cursor?: string,
    signal?: AbortSignal,
    trashed?: boolean,
  ): Promise<FilePage>;
  setTrashed(projectId: string, id: string, trashed: boolean, signal?: AbortSignal): Promise<void>;
  emptyTrash(projectId: string, signal?: AbortSignal): Promise<void>;
  upload(projectId: string, file: File, signal?: AbortSignal): Promise<ProjectFile>;
  content(projectId: string, file: ProjectFile, signal?: AbortSignal): Promise<Uint8Array>;
}
/** @id CODE-SVC-003 @implements REQ-SVC-006 REQ-SVC-007 */
export function createFilesApi(auth: BrowserAuth): FilesApi {
  const badContent = () =>
    new ApiError(503, 'ファイルの完全性を確認できませんでした。再読み込みして再試行してください。');
  function current(accountId: string | undefined, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!accountId || auth.account()?.id !== accountId)
      throw new ApiError(401, 'アカウントが変更されました。もう一度サインインしてください。');
  }
  async function check(response: Response) {
    if (response.ok) return;
    await response.body?.cancel();
    throw new ApiError(
      response.status,
      'ファイル操作に失敗しました。入力・容量・接続を確認して再試行してください。',
    );
  }
  async function read(
    response: Response,
    limit: number,
    exact: boolean,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const buffer = new Uint8Array(limit);
    const reader = response.body?.getReader();
    let offset = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (offset + next.value.byteLength > limit) throw badContent();
          buffer.set(next.value, offset);
          offset += next.value.byteLength;
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    }
    if (exact && offset !== limit) throw badContent();
    return buffer.subarray(0, offset);
  }
  async function json(response: Response) {
    await check(response);
    const bytes = await read(response, 512 * 1024, false);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new ApiError(503, 'ファイル情報を取得できませんでした。再読み込みしてください。');
    }
  }
  const path = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/files`;
  return {
    list: async (projectId, cursor, signal, trashed = false) => {
      const accountId = auth.account()?.id;
      const query = new URLSearchParams();
      if (cursor !== undefined) query.set('cursor', cursor);
      if (trashed) query.set('trashed', 'true');
      const value = await json(
        await authorizedFetch(auth, `${path(projectId)}${query.size ? `?${query}` : ''}`, {
          method: 'GET',
          signal,
        }),
      );
      current(accountId, signal);
      const parsed = filePageSchema.safeParse(value);
      if (!parsed.success) throw badContent();
      return parsed.data;
    },
    /** @id CODE-FEX-005 @implements REQ-FEX-002 REQ-FEX-003 */
    setTrashed: async (projectId, id, trashed, signal) => {
      const accountId = auth.account()?.id;
      const response = await authorizedFetch(
        auth,
        `${path(projectId)}/${encodeURIComponent(id)}${trashed ? '' : '/restore'}`,
        { method: trashed ? 'DELETE' : 'POST', signal },
      );
      if (!trashed && response.status === 409) {
        await response.body?.cancel();
        throw new ApiError(409, '完全削除が中断されています。ごみ箱をもう一度空にしてください。');
      }
      await check(response);
      current(accountId, signal);
      if (response.status !== 204) {
        await response.body?.cancel();
        throw badContent();
      }
    },
    /** @id CODE-FTP-005 @implements REQ-FTP-001 REQ-FTP-003 */
    emptyTrash: async (projectId, signal) => {
      const accountId = auth.account()?.id;
      const response = await authorizedFetch(auth, `${path(projectId)}/trash`, {
        method: 'DELETE',
        signal,
      });
      current(accountId, signal);
      if (response.status !== 204) {
        await response.body?.cancel();
        throw new ApiError(
          response.ok ? 503 : response.status,
          '一部のファイルが完全削除された可能性があります。ごみ箱を再読み込みし、もう一度空にしてください。',
        );
      }
    },
    upload: async (projectId, file, signal) => {
      const accountId = auth.account()?.id;
      const value = await json(
        await authorizedFetch(auth, path(projectId), {
          method: 'POST',
          signal,
          body: file,
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
            'X-File-Size': String(file.size),
          },
        }),
      );
      current(accountId, signal);
      const parsed = projectFileSchema.safeParse(value);
      if (!parsed.success) throw badContent();
      return parsed.data;
    },
    content: async (projectId, metadata, signal) => {
      const file = projectFileSchema.parse(metadata),
        accountId = auth.account()?.id;
      if (file.size > MAX_FILE_BYTES) throw badContent();
      const response = await authorizedFetch(
        auth,
        `${path(projectId)}/${encodeURIComponent(file.id)}/content`,
        { method: 'GET', signal },
      );
      await check(response);
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^(0|[1-9]\d*)$/.test(length) || Number(length) !== file.size)) {
        await response.body?.cancel();
        throw badContent();
      }
      const bytes = await read(response, file.size, true);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      current(accountId, signal);
      if (sha !== file.sha256) throw badContent();
      return bytes;
    },
  };
}
