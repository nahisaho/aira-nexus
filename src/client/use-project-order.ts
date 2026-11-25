import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectOrderMove, ProjectOrderSnapshot } from '../shared/project-order';
import { ApiError } from './api';
import type { ProjectOrderApi } from './project-order-api';
import { ProjectOrderUnavailable } from './project-order-api';

export type BeginProjectWrite = () => (() => void) | null;
type Phase = 'loading' | 'ready' | 'saving' | 'error' | 'unavailable';

/** @id CODE-SID-015 @implements REQ-SID-008 REQ-SID-009 */
export function useProjectOrder(
  api: ProjectOrderApi,
  captureSession: () => () => boolean,
  beginWrite: BeginProjectWrite,
  onAuthenticationError: (cause: unknown) => void,
  refreshKey: string,
) {
  const [snapshot, setSnapshot] = useState<ProjectOrderSnapshot | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const phaseRef = useRef<Phase>('loading');
  const mounted = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const reloadAfterWrite = useRef(false);
  const snapshotRef = useRef(snapshot);
  const changePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  const acknowledge = useCallback((value: ProjectOrderSnapshot | null) => {
    snapshotRef.current = value;
    setSnapshot(value);
  }, []);
  const failed = useCallback(
    (cause: unknown) => {
      if (cause instanceof ProjectOrderUnavailable) {
        acknowledge(null);
        setError('');
        changePhase('unavailable');
      } else {
        setError(
          cause instanceof ApiError
            ? cause.message
            : '並び順の操作に失敗しました。再読み込みして再試行してください。',
        );
        changePhase('error');
        if (cause instanceof ApiError && cause.status === 401) onAuthenticationError(cause);
      }
    },
    [acknowledge, changePhase, onAuthenticationError],
  );
  const reload = useCallback(async () => {
    if (writing.current) {
      reloadAfterWrite.current = true;
      return;
    }
    const sessionCurrent = captureSession();
    const sequence = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = () =>
      mounted.current &&
      sequence === generation.current &&
      !request.signal.aborted &&
      sessionCurrent();
    changePhase('loading');
    setError('');
    try {
      const enabled = await api.capabilities(request.signal);
      if (!current()) return;
      if (!enabled) {
        acknowledge(null);
        changePhase('unavailable');
        return;
      }
      const result = await api.get(request.signal);
      if (current()) {
        acknowledge(result);
        changePhase('ready');
      }
    } catch (cause) {
      if (current()) failed(cause);
    }
  }, [api, captureSession, changePhase, acknowledge, failed]);
  useEffect(() => {
    mounted.current = true;
    const focus = () => {
      if (phaseRef.current !== 'unavailable') void reload();
    };
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.removeEventListener('focus', focus);
    };
  }, [reload]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const move = useCallback(
    async (input: ProjectOrderMove) => {
      const confirmed = snapshotRef.current;
      if (writing.current || phaseRef.current !== 'ready' || !confirmed) return;
      const release = beginWrite();
      if (!release) return;
      writing.current = true;
      const sessionCurrent = captureSession();
      const sequence = ++generation.current;
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      const current = () =>
        mounted.current &&
        sequence === generation.current &&
        !request.signal.aborted &&
        sessionCurrent();
      changePhase('saving');
      setError('');
      try {
        const result = await api.move(confirmed.version, input, request.signal);
        if (current()) {
          acknowledge(result);
          changePhase('ready');
        }
      } catch (cause) {
        reloadAfterWrite.current = false;
        if (current()) failed(cause);
      } finally {
        writing.current = false;
        release();
        if (reloadAfterWrite.current && current()) {
          reloadAfterWrite.current = false;
          void reload();
        }
      }
    },
    [api, beginWrite, captureSession, changePhase, acknowledge, failed, reload],
  );
  return { snapshot, phase, error, reload, move };
}
