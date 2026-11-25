import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createTokenVerifier } from './identity.js';
import { ProjectRepository } from './projects.js';
import { ProjectPinsRepository } from './project-pins.js';
import { ProjectOrderRepository } from './project-order.js';
import { CopilotService } from './copilot/service.js';
import { GitHubDeviceProvider } from './copilot/provider.js';
import { TokenVault } from './copilot/secrets.js';
import { ChatConsentRepository, ChatConsentService } from './chat/consent.js';
import { ChatRuntime } from './chat/runtime.js';
import { PreferencesRepository } from './preferences.js';
import { FileRepository } from './files/repository.js';
import { FileService } from './files/service.js';
import { AzureBlobStore } from './files/store.js';
import { JobRepository } from './jobs/repository.js';
import { JobService } from './jobs/service.js';
import { productionJobHandlers } from './jobs/worker.js';
import { ConversionFileRepository, ConversionRepository } from './conversion/repository.js';
import { ChatRepository } from './chat/repository.js';
import { ChatService } from './chat/service.js';
import { createNotebookOptions } from './notebook/runtime.js';
import { NotebookRepository } from './notebook/repository.js';
import { NotebookService, startNotebookReclaimer } from './notebook/service.js';

const config = readConfig(process.env);
const pool = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  max: 20,
});
pool.on('error', () => console.error('Database connection unavailable.'));
const conversions = config.conversion ? new ConversionRepository(pool) : undefined;
const copilot = config.copilot
  ? new CopilotService({
      pool,
      provider: new GitHubDeviceProvider(config.copilot.clientId),
      secrets: new TokenVault(config.copilot.encryptionKey),
    })
  : undefined;
const chatConsent =
  config.chatEnabled && copilot
    ? new ChatConsentService(new ChatConsentRepository(pool), copilot, new ChatRuntime())
    : undefined;
const chat = config.chatEnabled
  ? new ChatService(new ChatRepository(pool), config, !!chatConsent, chatConsent)
  : undefined;
const files = config.files
  ? new FileService(
      conversions ? new ConversionFileRepository(pool, conversions) : new FileRepository(pool),
      new AzureBlobStore(config.files),
    )
  : undefined;
const notebook = createNotebookOptions(config.notebookEnabled === true, pool, files);
const stopNotebookReclaimer = notebook
  ? startNotebookReclaimer(
      new NotebookService(new NotebookRepository(pool), notebook.runtime, files),
    )
  : undefined;
/** @id CODE-SID-005 @implements REQ-SID-002 */
const app = createApp({
  config,
  projects: new ProjectRepository(pool),
  preferences: new PreferencesRepository(pool),
  verifyToken: createTokenVerifier(config),
  ...(conversions ? { conversions } : {}),
  ...(chat ? { chat } : {}),
  ...(config.projectPinsEnabled ? { projectPins: new ProjectPinsRepository(pool) } : {}),
  ...(config.projectOrderEnabled ? { projectOrder: new ProjectOrderRepository(pool) } : {}),
  ...(config.jobsEnabled
    ? { jobs: new JobService(new JobRepository(pool), productionJobHandlers) }
    : {}),
  ...(files ? { files } : {}),
  ...(notebook ? { notebook } : {}),
  ...(copilot ? { copilot } : {}),
});
app.get('/assets/*', serveStatic({ root: './dist/client' }));
app.get('/pdf-assets/*', serveStatic({ root: './dist/client' }));
app.get('/markdown-assets/renderer.js', serveStatic({ root: './dist/client' }));
app.get('/markdown-renderer.html', serveStatic({ path: './dist/client/markdown-renderer.html' }));
app.get('/auth-redirect.html', serveStatic({ path: './dist/client/auth-redirect.html' }));
app.get('/', serveStatic({ path: './dist/client/index.html' }));
/** @id CODE-TUN-002 @implements REQ-TUN-002 */
const hostname = config.bindHost ?? '0.0.0.0';
if (config.bindHost === undefined)
  console.warn('BIND_HOST is unset; legacy non-loopback binding is active.');
const server = serve({ fetch: app.fetch, hostname, port: config.port }, () => {
  console.info(`AIRA Nexus listening on port ${config.port}.`);
});
function shutdown() {
  stopNotebookReclaimer?.();
  const deadline = setTimeout(() => {
    console.error('Shutdown deadline exceeded.');
    process.exit(1);
  }, 15_000);
  deadline.unref();
  server.close(() => {
    void pool
      .end()
      .then(() => {
        clearTimeout(deadline);
      })
      .catch(() => {
        console.error('Database shutdown failed.');
        process.exitCode = 1;
      });
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
