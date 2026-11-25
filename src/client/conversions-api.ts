import type { BrowserAuth } from './auth';
import type { ConversionPage, ConversionRequest } from '../shared/conversions';
import { conversionPageSchema, conversionRequestSchema } from '../shared/conversions';
import { z } from 'zod';
import { ApiError, authorizedFetch } from './api';
import protocol from '../shared/conversion-protocol.json' with { type: 'json' };
import type { ProjectFile } from '../shared/files';

export interface ConversionsApi {
  capabilities(project: string, signal?: AbortSignal): Promise<{ enabled: boolean }>;
  list(project: string, cursor?: string, signal?: AbortSignal): Promise<ConversionPage>;
  request(
    project: string,
    source: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<ConversionRequest>;
  cancel(project: string, id: string, signal?: AbortSignal): Promise<ConversionRequest>;
}
export const conversionUnavailable = '文書変換は現在利用できません。';
const conversionFailed = '文書変換の操作に失敗しました。再読み込みして再試行してください。';
export function conversionError(cause: unknown) {
  return cause instanceof ApiError && cause.status === 503
    ? conversionUnavailable
    : conversionFailed;
}
export function conversionEligibility(file: ProjectFile): string | null {
  if (!protocol.formats.includes(file.name.split('.').at(-1)?.toLowerCase() ?? ''))
    return 'この形式は文書変換に対応していません。';
  return file.size > protocol.limits.inputBytes
    ? '文書変換は25MB以下のファイルに対応しています。'
    : null;
}
/** @id CODE-CJU-001 @implements REQ-CJU-004 */
export function createConversionsApi(auth: BrowserAuth): ConversionsApi {
  const invalid = () =>
    new ApiError(503, '文書変換の応答を確認できませんでした。再読み込みしてください。');
  const input = () => new ApiError(400, conversionFailed);
  const uuid = (value: string) => {
    if (!z.uuid().safeParse(value).success) throw input();
    return encodeURIComponent(value);
  };
  const path = (project: string) => `/api/projects/${uuid(project)}`;
  function current(owner: string | undefined, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!owner || auth.account()?.id !== owner)
      throw new ApiError(401, 'アカウントが変更されました。もう一度サインインしてください。');
  }
  async function json(
    url: string,
    method: string,
    statuses: number[],
    signal?: AbortSignal,
    key?: string,
  ): Promise<unknown> {
    const owner = auth.account()?.id;
    const response = await authorizedFetch(auth, url, {
      method,
      signal,
      ...(key
        ? {
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
            body: '{}',
          }
        : {}),
    });
    current(owner, signal);
    if (!statuses.includes(response.status)) {
      await response.body?.cancel();
      current(owner, signal);
      throw response.ok
        ? invalid()
        : new ApiError(
            response.status,
            response.status === 503 ? conversionUnavailable : conversionFailed,
          );
    }
    const limit = 512 * 1024;
    const length = response.headers.get('Content-Length');
    if (
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '') ||
      (length !== null && (!/^(0|[1-9]\d*)$/.test(length) || Number(length) > limit))
    ) {
      await response.body?.cancel();
      current(owner, signal);
      throw invalid();
    }
    const bytes = new Uint8Array(limit);
    const reader = response.body?.getReader();
    let offset = 0;
    if (reader) {
      try {
        for (;;) {
          const next = await reader.read();
          current(owner, signal);
          if (next.done) break;
          if (offset + next.value.byteLength > limit) throw invalid();
          bytes.set(next.value, offset);
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
    current(owner, signal);
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)),
      );
    } catch {
      throw invalid();
    }
  }
  function request(value: unknown, project: string) {
    const parsed = conversionRequestSchema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== project) throw invalid();
    const artifacts = parsed.data.artifacts;
    if (
      artifacts &&
      (artifacts.markdown.id === artifacts.json.id ||
        [artifacts.markdown, artifacts.json].some(
          (artifact, index) =>
            artifact.file &&
            (artifact.file.kind !== 'text' ||
              artifact.file.size > protocol.limits.outputBytes ||
              !artifact.file.name.toLowerCase().endsWith(index === 0 ? '.md' : '.json')),
        ))
    )
      throw invalid();
    return parsed.data;
  }
  return {
    capabilities: async (project, signal) => {
      const value = await json(`${path(project)}/conversions/capabilities`, 'GET', [200], signal);
      const parsed = z.strictObject({ enabled: z.boolean() }).safeParse(value);
      if (!parsed.success) throw invalid();
      return parsed.data;
    },
    list: async (project, cursor, signal) => {
      if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw input();
      const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor })}`;
      const value = await json(`${path(project)}/conversions${query}`, 'GET', [200], signal);
      const parsed = conversionPageSchema.safeParse(value);
      if (!parsed.success) throw invalid();
      const items = parsed.data.items.map((item) => request(item, project));
      if (new Set(items.map((item) => item.id)).size !== items.length) throw invalid();
      return { ...parsed.data, items };
    },
    request: async (project, source, key, signal) => {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw input();
      const value = request(
        await json(
          `${path(project)}/files/${uuid(source)}/conversions`,
          'POST',
          [200, 202],
          signal,
          key,
        ),
        project,
      );
      if (value.sourceId !== source) throw invalid();
      return value;
    },
    cancel: async (project, id, signal) => {
      const value = request(
        await json(`${path(project)}/conversions/${uuid(id)}/cancel`, 'POST', [200], signal),
        project,
      );
      if (value.id !== id) throw invalid();
      return value;
    },
  };
}
