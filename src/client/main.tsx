import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { App } from './App';
import { createBrowserAuth } from './auth';
import { createProjectsApi } from './api';
import { createPreferencesApi, createTextSizeApi } from './preferences-api';
import { createFilesApi } from './files-api';
import { createProjectPinsApi } from './project-pins-api';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root is missing.');
const root = createRoot(rootElement);
async function start() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Application configuration is unavailable.');
  const config = z
    .strictObject({
      tenantId: z.uuid(),
      apiClientId: z.uuid(),
      spaClientId: z.uuid(),
      scope: z.string(),
      publicOrigin: z.url(),
    })
    .parse(await response.json());
  if (
    config.publicOrigin !== window.location.origin ||
    config.scope !== `api://${config.apiClientId}/access_as_user`
  )
    throw new Error('Application configuration does not match this origin.');
  const auth = await createBrowserAuth(config);
  root.render(
    <App
      auth={auth}
      api={createProjectsApi(auth)}
      preferencesApi={createPreferencesApi(auth)}
      textSizeApi={createTextSizeApi(auth)}
      filesApi={createFilesApi(auth)}
      pinsApi={createProjectPinsApi(auth)}
    />,
  );
}
void start().catch(() => {
  root.render(
    <main role="alert" className="mx-auto max-w-xl p-12">
      <h1 className="mb-4 text-xl font-semibold">ワークスペースを起動できませんでした。</h1>
      <p>
        接続とサービス設定を確認し、ページを再読み込みしてください。問題が続く場合は管理者にお問い合わせください。
      </p>
    </main>,
  );
});
