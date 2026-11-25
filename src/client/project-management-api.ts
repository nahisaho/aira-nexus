import { z } from 'zod';
import type { BrowserAuth } from './auth';
import { ApiError, authorizedFetch } from './api';

const projectSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const managedProjectSchema = z.strictObject({
  project: projectSchema,
  description: z.string(),
  trashedAt: z.iso.datetime().nullable(),
});
export type ManagedProject = z.infer<typeof managedProjectSchema>;
export type ProjectManagementApi = ReturnType<typeof createProjectManagementApi>;
const capabilitySchema = z.strictObject({ enabled: z.boolean() });
const trashSchema = z
  .strictObject({ items: z.array(managedProjectSchema) })
  .refine(
    ({ items }) =>
      items.every((item) => item.trashedAt !== null) &&
      new Set(items.map((item) => item.project.id)).size === items.length,
  );
const failureSchema = z.object({ error: z.object({ code: z.string() }) });
const invalidInput = '名前は制御文字を含まない1〜100文字、説明は2000文字以内で入力してください。';
const malformedResponse = 'プロジェクト設定の応答を確認できませんでした。再読み込みしてください。';

/** @id CODE-DLG-001 @implements REQ-DLG-001 REQ-DLG-002 REQ-DLG-003 REQ-DLG-004 */
export function projectManagementInput(name: string, description: string) {
  const normalized = description.replace(/\r\n/g, '\n');
  // The backend counts Unicode code points, not UTF-16 code units.
  const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  if (
    /\p{Cc}/u.test(name) ||
    !name.trim() ||
    Array.from(name.trim()).length > 100 ||
    Array.from(normalized).length > 2000 ||
    normalized.includes('\0') ||
    invalidUnicode.test(name) ||
    invalidUnicode.test(normalized)
  )
    throw new ApiError(400, invalidInput);
  return { name: name.trim(), description: normalized };
}

export function createProjectManagementApi(auth: BrowserAuth) {
  async function request(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    signal: AbortSignal,
    body?: { name: string; description: string } | Record<string, never>,
    version?: number,
  ): Promise<unknown> {
    const owner = auth.account()?.id;
    const response = await authorizedFetch(auth, `/api/project-management${path}`, {
      method,
      signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      signal.throwIfAborted();
      throw new ApiError(response.ok ? 502 : response.status, malformedResponse);
    }
    signal.throwIfAborted();
    if (owner !== auth.account()?.id) throw new ApiError(401, 'サインインしてください。');
    if (!response.ok) {
      const code = failureSchema.safeParse(data).data?.error.code;
      const message =
        code === 'PROJECT_BUSY'
          ? '実行中の処理があるため、アーカイブできません。'
          : response.status === 409
            ? '競合しました。再読み込みしてから変更してください。'
            : response.status === 401
              ? '認証の有効期限が切れました。もう一度サインインしてください。'
              : response.status === 403
                ? '利用権限がありません。管理者にアプリの割り当てを確認してください。'
                : response.status === 404
                  ? 'プロジェクトが見つかりません。再読み込みしてください。'
                  : response.status === 400 || response.status === 413
                    ? invalidInput
                    : code === 'PROJECT_MANAGEMENT_UNAVAILABLE'
                      ? 'プロジェクト設定は現在利用できません。'
                      : 'プロジェクト設定を取得・保存できませんでした。再試行してください。';
      throw new ApiError(response.status, message);
    }
    return data;
  }
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError(502, malformedResponse);
    return result.data;
  }
  async function record(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    signal: AbortSignal,
    body?: { name: string; description: string } | Record<string, never>,
    version?: number,
    trashed = false,
  ) {
    const result = parse(managedProjectSchema, await request(path, method, signal, body, version));
    if ((result.trashedAt !== null) !== trashed) throw new ApiError(502, malformedResponse);
    return result;
  }
  const projectPath = (id: string) => {
    if (!z.uuid().safeParse(id).success)
      throw new ApiError(404, 'プロジェクトが見つかりません。再読み込みしてください。');
    return `/projects/${id}`;
  };
  return {
    capabilities: async (signal: AbortSignal) =>
      parse(capabilitySchema, await request('/capabilities', 'GET', signal)).enabled,
    get: (id: string, signal: AbortSignal) => record(projectPath(id), 'GET', signal),
    create: (name: string, description: string, signal: AbortSignal) =>
      record('/projects', 'POST', signal, projectManagementInput(name, description)),
    update: (project: ManagedProject, name: string, description: string, signal: AbortSignal) =>
      record(
        projectPath(project.project.id),
        'PATCH',
        signal,
        projectManagementInput(name, description),
        project.project.version,
      ),
    trash: async (signal: AbortSignal) =>
      parse(trashSchema, await request('/trash', 'GET', signal)).items,
    transition: (item: ManagedProject, action: 'trash' | 'restore', signal: AbortSignal) =>
      record(
        `${projectPath(item.project.id)}/${action}`,
        'POST',
        signal,
        {},
        item.project.version,
        action === 'trash',
      ),
  };
}
