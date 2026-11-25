import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { TextSizeApi } from './preferences-api';
import { TextSizeUnavailableError } from './preferences-api';
import { defaultTextSize, textSizeSchema } from '../shared/preferences';
import type { TextSizePreference } from '../shared/preferences';
import { ApiError } from './api';

interface State {
  owner: string | null;
  epoch: number;
  value: TextSizePreference;
  status: 'loading' | 'ready' | 'saving' | 'failed' | 'unavailable';
  error: string;
  acknowledged: boolean;
}

/** @id CODE-FONT-004 @implements REQ-FONT-003 REQ-FONT-004 */
export function useTextSize(
  owner: string | null,
  generation: number,
  captureSession: () => () => boolean,
  api: TextSizeApi,
  onAuthenticationError: (cause: unknown) => void,
) {
  const baseline: State = {
    owner,
    epoch: generation,
    value: defaultTextSize,
    status: 'loading',
    error: '',
    acknowledged: false,
  };
  const [state, setState] = useState<State>(baseline);
  const [revision, setRevision] = useState(0);
  const request = useRef<{ active: AbortController; valid: () => boolean }>({
    active: new AbortController(),
    valid: () => false,
  });
  const saving = useRef(false);
  useLayoutEffect(() => {
    const active = new AbortController();
    saving.current = false;
    const fence = captureSession();
    const signal = active.signal;
    const valid = () => !signal.aborted && fence();
    request.current = { active, valid };
    setState((previous) => ({
      owner,
      epoch: generation,
      value:
        previous.owner === owner && previous.epoch === generation
          ? previous.value
          : defaultTextSize,
      status: 'loading',
      error: '',
      acknowledged:
        previous.owner === owner && previous.epoch === generation && previous.acknowledged,
    }));
    if (owner)
      void api
        .get(signal)
        .then((result) => {
          const value = textSizeSchema.parse(result);
          if (valid())
            setState({
              owner,
              epoch: generation,
              value,
              status: 'ready',
              error: '',
              acknowledged: true,
            });
        })
        .catch((cause: unknown) => {
          if (!valid()) return;
          if (cause instanceof ApiError && cause.status === 401) {
            onAuthenticationError(cause);
            return;
          }
          setState((previous) => ({
            ...previous,
            status: cause instanceof TextSizeUnavailableError ? 'unavailable' : 'failed',
            error:
              cause instanceof ApiError
                ? cause.message
                : '文字サイズを取得できませんでした。再試行してください。',
          }));
        });
    return () => active.abort();
  }, [owner, generation, captureSession, api, revision, onAuthenticationError]);
  const current = owner && state.owner === owner && state.epoch === generation ? state : baseline;
  useLayoutEffect(() => {
    document.documentElement.dataset.textSize = current.value.size;
    return () => {
      document.documentElement.dataset.textSize = 'large';
    };
  }, [current.value.size]);
  const save = useCallback(
    async (changes: TextSizePreference) => {
      const { active, valid } = request.current;
      const signal = active.signal;
      if (
        !owner ||
        !valid() ||
        saving.current ||
        state.owner !== owner ||
        state.epoch !== generation ||
        state.status !== 'ready'
      )
        return;
      saving.current = true;
      setState((previous) => ({ ...previous, status: 'saving', error: '' }));
      try {
        const value = textSizeSchema.parse(await api.patch(changes, signal));
        if (valid())
          setState({
            owner,
            epoch: generation,
            value,
            status: 'ready',
            error: '',
            acknowledged: true,
          });
      } catch (cause) {
        if (!valid()) return;
        if (cause instanceof ApiError && cause.status === 401) {
          onAuthenticationError(cause);
          return;
        }
        setState((previous) => ({
          ...previous,
          status: cause instanceof TextSizeUnavailableError ? 'unavailable' : 'ready',
          error:
            cause instanceof ApiError
              ? cause.message
              : '文字サイズを保存できませんでした。再試行してください。',
        }));
      } finally {
        if (valid()) saving.current = false;
      }
    },
    [owner, generation, api, state, onAuthenticationError],
  );
  return {
    value: current.value,
    save,
    disabled: !owner || current.status !== 'ready',
    saving: current.status === 'saving',
    error: current.error,
    unsaved: !current.acknowledged && current.status === 'failed',
    reload: () => setRevision((value) => value + 1),
  };
}
export type TextSizeControls = ReturnType<typeof useTextSize>;
