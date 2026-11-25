import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserAuth } from './auth';
import type { PreferencesApi } from './preferences-api';
import { defaultPreferences, preferencesSchema } from '../shared/preferences';
import type { UserPreferences } from '../shared/preferences';
import { ApiError } from './api';
import { translate } from './i18n';
interface State {
  owner: string | null;
  value: UserPreferences;
  status: 'loading' | 'ready' | 'saving' | 'failed';
  error: string;
}
/** @id CODE-PREF-004 @implements REQ-PREF-003 REQ-PREF-004 */
export function useUserPreferences(
  auth: BrowserAuth,
  owner: string | null,
  api: PreferencesApi,
  onAuthenticationError: (cause: unknown) => void,
) {
  const [state, setState] = useState<State>({
    owner: null,
    value: defaultPreferences,
    status: 'loading',
    error: '',
  });
  const [revision, setRevision] = useState(0);
  const controller = useRef(new AbortController());
  const saving = useRef(false);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    saving.current = false;
    const valid = () => !active.signal.aborted && auth.account()?.id === owner;
    setState({ owner, value: defaultPreferences, status: owner ? 'loading' : 'ready', error: '' });
    if (owner)
      void api
        .get(active.signal)
        .then((result) => {
          const value = preferencesSchema.parse(result);
          if (valid()) setState({ owner, value, status: 'ready', error: '' });
        })
        .catch((cause: unknown) => {
          if (!valid()) return;
          if (cause instanceof ApiError && cause.status === 401) onAuthenticationError(cause);
          setState({
            owner,
            value: defaultPreferences,
            status: 'failed',
            error:
              cause instanceof ApiError
                ? cause.message
                : '設定を取得できませんでした。再試行してください。',
          });
        });
    return () => active.abort();
  }, [auth, owner, api, revision, onAuthenticationError]);
  const value = owner && state.owner === owner ? state.value : defaultPreferences;
  useLayoutEffect(() => {
    document.documentElement.lang = value.language;
    document.documentElement.dataset.theme = value.theme;
    return () => {
      document.documentElement.lang = defaultPreferences.language;
      document.documentElement.dataset.theme = defaultPreferences.theme;
    };
  }, [value.language, value.theme]);
  const save = useCallback(
    async (changes: Partial<UserPreferences>) => {
      const active = controller.current;
      const valid = () => !active.signal.aborted && auth.account()?.id === owner;
      if (!owner || !valid()) return;
      if (saving.current || state.owner !== owner || state.status !== 'ready') {
        setState((previous) => ({
          ...previous,
          error: '設定の読み込み・保存が終わるまでお待ちください。',
        }));
        return;
      }
      saving.current = true;
      setState((previous) => ({ ...previous, status: 'saving', error: '' }));
      try {
        const result = preferencesSchema.parse(await api.patch(changes, active.signal));
        if (valid()) setState({ owner, value: result, status: 'ready', error: '' });
      } catch (cause) {
        if (valid()) {
          if (cause instanceof ApiError && cause.status === 401) onAuthenticationError(cause);
          setState((previous) => ({
            ...previous,
            status: 'ready',
            error:
              cause instanceof ApiError
                ? cause.message
                : '設定を保存できませんでした。再試行してください。',
          }));
        }
      } finally {
        if (valid()) saving.current = false;
      }
    },
    [auth, owner, api, state.owner, state.status, onAuthenticationError],
  );
  return {
    value,
    save,
    t: (text: string) => translate(value.language, text),
    disabled: !owner || state.owner !== owner || state.status !== 'ready',
    saving: state.owner === owner && state.status === 'saving',
    error: state.owner === owner ? state.error : '',
    reload: () => setRevision((previous) => previous + 1),
  };
}
export type PreferenceControls = ReturnType<typeof useUserPreferences>;
