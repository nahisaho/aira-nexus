import { Pool } from 'pg';
import { JobRepository } from './repository.js';
import { JobWorker, jobsEnabled, productionJobHandlers } from './worker.js';
import { readFileStorageConfig } from '../files/config.js';
import { AzureBlobStore } from '../files/store.js';
import { readConversionConfig } from '../conversion/config.js';
import { ConversionRepository } from '../conversion/repository.js';
import { DoclingRuntime } from '../conversion/runtime.js';
import { conversionHandlers } from '../conversion/worker.js';
import { chatHandlers } from '../chat/worker.js';
import { ChatRepository } from '../chat/repository.js';
import { ChatRuntime } from '../chat/runtime.js';
import { chatEnabled } from '../chat/config.js';
import { readConfig } from '../config.js';
import { CopilotService } from '../copilot/service.js';
import { GitHubDeviceProvider } from '../copilot/provider.js';
import { TokenVault } from '../copilot/secrets.js';

/** @id CODE-SVC-016 @implements REQ-SVC-014 */
async function main(): Promise<void> {
  if (!jobsEnabled(process.env)) throw new Error('Jobs are disabled.');
  const files =
    process.env.DOCUMENT_CONVERSION_ENABLED === 'true'
      ? readFileStorageConfig(process.env)
      : undefined;
  const conversion = readConversionConfig(process.env, {
    jobsEnabled: true,
    filesConfigured: !!files,
  });
  const chatConfig = chatEnabled(process.env) ? readConfig(process.env) : undefined;
  const database = process.env.DATABASE_URL;
  if (!database) throw new Error('Worker database configuration is required.');
  const url = new URL(database);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2
  )
    throw new Error('Invalid worker database configuration.');
  const pool = new Pool({
    connectionString: database,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  pool.on('error', () => console.error(JSON.stringify({ event: 'job_database_unavailable' })));
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    deadline = setTimeout(() => {
      console.error(JSON.stringify({ event: 'job_shutdown_unconfirmed' }));
      process.exit(1);
    }, 15000);
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const repository = new JobRepository(pool);
    const handlers = new Map(productionJobHandlers);
    let beforeClaim: (() => Promise<void>) | undefined;
    if (chatConfig?.chatEnabled && chatConfig.copilot) {
      const copilot = new CopilotService({
        pool,
        provider: new GitHubDeviceProvider(chatConfig.copilot.clientId),
        secrets: new TokenVault(chatConfig.copilot.encryptionKey),
      });
      for (const [type, handler] of chatHandlers(
        new ChatRepository(pool),
        copilot,
        new ChatRuntime(),
      ))
        handlers.set(type, handler);
    }
    if (conversion && files) {
      const conversions = new ConversionRepository(pool);
      const converter = new DoclingRuntime(conversion);
      await conversions.ready();
      await converter.ready((jobId, fence) => conversions.claimIsCurrent(jobId, fence));
      for (const [type, handler] of conversionHandlers(
        conversions,
        new AzureBlobStore(files),
        converter,
      ))
        handlers.set(type, handler);
      beforeClaim = async () => {
        await conversions.dispatch();
      };
    }
    if (handlers.size === 0) throw new Error('No job handlers are registered.');
    await new JobWorker(repository, handlers, {
      ...(beforeClaim ? { beforeClaim } : {}),
      pollMs: 1000,
    }).run(controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await pool.end();
    if (deadline) clearTimeout(deadline);
  }
}
void main().catch(() => {
  console.error(JSON.stringify({ event: 'job_worker_unavailable' }));
  process.exitCode = 1;
});
