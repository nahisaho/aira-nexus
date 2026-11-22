import type { PublicConfig } from '../shared/contracts.js';
import { z } from 'zod';
import { readFileStorageConfig } from './files/config.js';
import type { FileStorageConfig } from './files/config.js';
import { jobsEnabled } from './jobs/worker.js';
import { readConversionConfig } from './conversion/config.js';
import type { ConversionRuntimeConfig } from './conversion/runtime.js';
import { chatEnabled } from './chat/config.js';

export const uuid = z.uuid();

export interface AppConfig {
  tenantId: string;
  apiClientId: string;
  spaClientId: string;
  publicOrigin: string;
  databaseUrl: string;
  port: number;
  bindHost?: '127.0.0.1';
  copilot?: { clientId: string; encryptionKey: string };
  files?: FileStorageConfig;
  jobsEnabled?: boolean;
  conversion?: ConversionRuntimeConfig;
  projectPinsEnabled?: boolean;
  projectManagementEnabled?: boolean;
  projectOrderEnabled?: boolean;
  textSizeEnabled?: boolean;
  chatEnabled?: true;
}

/** @id CODE-SID-012 @implements REQ-SID-009 */
function projectOrderEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.PROJECT_ORDER_ENABLED;
  if (flag === undefined || flag === 'false') return false;
  if (flag === 'true') return true;
  throw new Error('Invalid PROJECT_ORDER_ENABLED configuration.');
}

/** @id CODE-FONT-003 @implements REQ-FONT-002 */
function textSizeEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.TEXT_SIZE_ENABLED;
  if (flag === undefined || flag === 'false') return false;
  if (flag === 'true') return true;
  throw new Error('Invalid TEXT_SIZE_ENABLED configuration.');
}

/** @id CODE-PMG-005 @implements REQ-PMG-005 */
function projectManagementEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.PROJECT_MANAGEMENT_ENABLED;
  if (flag === undefined || flag === 'false') return false;
  if (flag === 'true') return true;
  throw new Error('Invalid PROJECT_MANAGEMENT_ENABLED configuration.');
}

/** @id CODE-SID-004 @implements REQ-SID-002 */
function projectPinsEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.PROJECT_PINS_ENABLED;
  if (flag === undefined || flag === 'false') return false;
  if (flag === 'true') return true;
  throw new Error('Invalid PROJECT_PINS_ENABLED configuration.');
}

/** @id CODE-CON-005 @implements REQ-CON-004 */
function copilotConfig(env: NodeJS.ProcessEnv): AppConfig['copilot'] {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const encryptionKey = env.COPILOT_TOKEN_ENCRYPTION_KEY;
  if (clientId === undefined && encryptionKey === undefined) return undefined;
  if (!clientId || !/^[A-Za-z0-9._-]{1,128}$/.test(clientId) || !encryptionKey)
    throw new Error('Invalid or incomplete Copilot configuration.');
  const key = Buffer.from(encryptionKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encryptionKey)
    throw new Error('Invalid Copilot encryption key.');
  return { clientId, encryptionKey };
}

/** @id CODE-ID-003 @implements REQ-ID-003 */
export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = z
    .object({
      ENTRA_TENANT_ID: uuid,
      ENTRA_API_CLIENT_ID: uuid,
      ENTRA_SPA_CLIENT_ID: uuid,
      PUBLIC_ORIGIN: z.url(),
      DATABASE_URL: z.url(),
      BIND_HOST: z.literal('127.0.0.1').optional(),
      PORT: z
        .string()
        .regex(/^[1-9]\d*$/)
        .default('3000'),
    })
    .safeParse(env);
  if (!parsed.success) throw new Error('Invalid or missing application configuration.');
  const values = parsed.data;
  const origin = new URL(values.PUBLIC_ORIGIN);
  const database = new URL(values.DATABASE_URL);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  const port = Number(values.PORT);
  const copilot = copilotConfig(env);
  const jobs = jobsEnabled(env);
  const chat = chatEnabled(env);
  if (chat && (!jobs || !copilot))
    throw new Error('CHAT_ENABLED requires jobs and Copilot configuration.');
  const files = readFileStorageConfig(env);
  const conversion = readConversionConfig(env, {
    jobsEnabled: jobs,
    filesConfigured: files !== undefined,
  });
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !database.hostname ||
    database.pathname.length < 2 ||
    !['https:', ...(loopback ? ['http:'] : [])].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !Number.isSafeInteger(port) ||
    port > 65535
  )
    throw new Error('Invalid application origin, database configuration or port.');
  return {
    tenantId: values.ENTRA_TENANT_ID.toLowerCase(),
    apiClientId: values.ENTRA_API_CLIENT_ID.toLowerCase(),
    spaClientId: values.ENTRA_SPA_CLIENT_ID.toLowerCase(),
    publicOrigin: origin.origin,
    databaseUrl: values.DATABASE_URL,
    port,
    ...(jobs ? { jobsEnabled: true } : {}),
    ...(conversion ? { conversion } : {}),
    ...(projectPinsEnabled(env) ? { projectPinsEnabled: true } : {}),
    ...(projectOrderEnabled(env) ? { projectOrderEnabled: true } : {}),
    ...(projectManagementEnabled(env) ? { projectManagementEnabled: true } : {}),
    ...(textSizeEnabled(env) ? { textSizeEnabled: true } : {}),
    ...(chat ? { chatEnabled: true } : {}),
    ...(values.BIND_HOST === undefined ? {} : { bindHost: values.BIND_HOST }),
    ...(copilot === undefined ? {} : { copilot }),
    ...(files === undefined ? {} : { files }),
  };
}

export function publicConfig(config: AppConfig): PublicConfig {
  return {
    tenantId: config.tenantId,
    apiClientId: config.apiClientId,
    spaClientId: config.spaClientId,
    scope: `api://${config.apiClientId}/access_as_user`,
    publicOrigin: config.publicOrigin,
  };
}
