import type { BrowserAuth } from './auth';
import { ApiError, authorizedFetch } from './api';
import { z } from 'zod';
import { projectPinsSchema } from '../shared/project-pins';

export interface ProjectPinsApi {
  list(signal?: AbortSignal): Promise<string[]>;
  set(projectId: string, pinned: boolean, signal?: AbortSignal): Promise<string[]>;
}
export class ProjectPinsUnavailable extends ApiError {
  constructor() {
    super(503, 'ピン留めは現在利用できません。');
  }
}
/** @id CODE-SID-006 @implements REQ-SID-003 */
export function createProjectPinsApi(auth: BrowserAuth): ProjectPinsApi {
  const unavailable = z.object({
    error: z.object({ code: z.literal('PROJECT_PINS_UNAVAILABLE') }),
  });
  async function request(
    path: string,
    method: 'GET' | 'PUT',
    signal?: AbortSignal,
    pinned?: boolean,
  ) {
    const accountId = auth.account()?.id;
    const response = await authorizedFetch(auth, path, {
      method,
      signal,
      ...(method === 'PUT'
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) }
        : {}),
    });
    let body: unknown;
    let malformed = false;
    try {
      body = await response.json();
    } catch {
      malformed = true;
    }
    signal?.throwIfAborted();
    if (auth.account()?.id !== accountId)
      throw new ApiError(401, 'アカウントが変更されました。もう一度サインインしてください。');
    if (!response.ok) {
      if (response.status === 503 && unavailable.safeParse(body).success)
        throw new ProjectPinsUnavailable();
      const message =
        response.status === 401
          ? '認証の有効期限が切れました。もう一度サインインしてください。'
          : response.status === 403
            ? '利用権限がありません。管理者にアプリの割り当てを確認してください。'
            : 'ピン留めの操作に失敗しました。再試行してください。';
      const requestId = response.headers.get('X-Request-ID');
      throw new ApiError(
        response.status,
        `${message}${requestId ? ` 受付番号: ${requestId}` : ''}`,
      );
    }
    if (malformed)
      throw new ApiError(502, 'ピン留めの応答を確認できませんでした。再読み込みしてください。');
    const parsed = projectPinsSchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError(502, 'ピン留めの応答を確認できませんでした。再読み込みしてください。');
    return parsed.data.projectIds;
  }
  return {
    list: (signal) => request('/api/project-pins', 'GET', signal),
    set: async (projectId, pinned, signal) => {
      if (!z.uuid().safeParse(projectId).success)
        throw new ApiError(404, 'プロジェクトが見つかりません。再読み込みしてください。');
      return request(`/api/projects/${projectId}/pin`, 'PUT', signal, pinned);
    },
  };
}
