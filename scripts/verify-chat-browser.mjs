import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: new globalThis.URL('../vite.config.ts', import.meta.url).pathname,
  logLevel: 'error',
  optimizeDeps: {
    entries: ['scripts/chat-browser-harness.tsx'],
    noDiscovery: true,
    include: ['react', 'react-dom/client'],
  },
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port.');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new globalThis.URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/src/client/main.tsx')
      return route.fulfill({ contentType: 'text/javascript', body: '' });
    return route.continue();
  });
  await page.goto(origin);
  await page.evaluate(async () => {
    const harness = await import('/scripts/chat-browser-harness.tsx');
    harness.mountChatBrowserReplay();
  });

  await page.getByRole('button', { name: 'モデルを更新' }).click();
  const discovery = page.getByRole('dialog', { name: /モデル一覧の取得/ });
  await discovery.getByRole('button', { name: 'モデル一覧を取得する' }).click();
  await page.getByRole('combobox', { name: 'モデル' }).selectOption('gpt-test');
  await page.getByRole('textbox', { name: 'メッセージ' }).fill('exact browser question');
  await page.getByRole('button', { name: 'プレビュー' }).click();
  const confirmation = page.getByRole('dialog', { name: /送信内容の確認/ });
  await confirmation.getByRole('button', { name: '送信を確認' }).click();
  await confirmation.getByRole('button', { name: '同じ送信を回復' }).click();
  await page.getByText('committed ').waitFor();
  await page.waitForFunction(() =>
    globalThis.window.__chatReplay?.stats().subscriptionOffsets.includes(1),
  );

  const abortedBeforeSwitch = await page.evaluate(
    () => globalThis.window.__chatReplay?.stats().abortedSubscriptions ?? 0,
  );
  await page.getByRole('button', { name: /22222222-2222-4222-8222-222222222222/ }).click();
  await page.waitForFunction(
    (previous) => globalThis.window.__chatReplay?.stats().abortedSubscriptions > previous,
    abortedBeforeSwitch,
  );
  await page.evaluate(() => globalThis.window.__chatReplay?.commitRemaining());
  await page.getByRole('button', { name: /11111111-1111-4111-8111-111111111111/ }).click();
  await page.getByText('committed after reconnect').waitFor();
  await page.getByText('完了').waitFor();

  const stats = await page.evaluate(() => globalThis.window.__chatReplay?.stats());
  if (
    !stats ||
    stats.confirmationKeys.length !== 2 ||
    stats.confirmationKeys[0] !== stats.confirmationKeys[1] ||
    stats.subscriptionOffsets.length < 2 ||
    stats.subscriptionOffsets.at(-1) !== 1 ||
    stats.abortedSubscriptions < 2 ||
    stats.committedRunCount !== 1
  )
    throw new Error(`Unexpected offline replay state: ${JSON.stringify(stats)}`);
  if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join('; ')}`);

  globalThis.console.log(
    JSON.stringify({
      status: 'PASS',
      browser: 'chromium',
      sameKeyRecovery: true,
      detachedSubscriptionAborted: true,
      replayedFromSequence: stats.subscriptionOffsets.at(-1),
      durableRuns: stats.committedRunCount,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
