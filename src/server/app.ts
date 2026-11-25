import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { publicConfig, uuid } from './config.js';
import { z } from 'zod';
import type { TokenVerifier } from './identity.js';
import type { ProjectRepository } from './projects.js';
import { ProjectError } from './projects.js';
import type { Principal } from '../shared/contracts.js';
import type { CopilotService } from './copilot/service.js';
import { CopilotError } from './copilot/errors.js';
import { InputError, readJson } from './http-input.js';
import { preferencePatchSchema, textSizeSchema } from '../shared/preferences.js';
import type { PreferencesRepository } from './preferences.js';
import type { FileService } from './files/service.js';
import { FileError } from './files/service.js';
import type { JobService } from './jobs/service.js';
import { JobError } from './jobs/errors.js';
import type { ProjectPinsRepository } from './project-pins.js';
import { projectPinInputSchema, projectPinsSchema } from '../shared/project-pins.js';
import type { ProjectOrderRepository } from './project-order.js';
import { projectOrderMoveSchema, projectOrderSnapshotSchema } from '../shared/project-order.js';
import { registerConversionRoutes } from './conversion/routes.js';
import type { ConversionRepository } from './conversion/repository.js';
import type { ChatService } from './chat/service.js';
import { ChatError } from './chat/errors.js';
import { registerChatRoutes } from './chat/routes.js';
import type { Pool } from 'pg';
import { NotebookRepository, NotebookError } from './notebook/repository.js';
import { NotebookService } from './notebook/service.js';
import type { NotebookDriver } from './notebook/service.js';
import { registerNotebookRoutes } from './notebook/routes.js';

export type Environment = { Variables: { principal: Principal; requestId: string } };

function failure(
  c: Context<Environment>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message, requestId: c.get('requestId') } }, status);
}

const projectInput = z.strictObject({
  name: z
    .string()
    .refine((value) => !/\p{Cc}/u.test(value))
    .transform((value) => value.trim())
    .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 100),
});

/** @id CODE-PROJ-003 @implements REQ-PROJ-003 */
async function projectName(request: Request): Promise<string> {
  const body = await readJson(request, 'A JSON object containing only name is required.');
  const parsed = projectInput.safeParse(body);
  if (!parsed.success)
    throw new InputError(
      400,
      'Name must contain 1–100 characters without control characters; no other fields are allowed.',
    );
  return parsed.data.name;
}

/** @id CODE-PMG-003 @implements REQ-PMG-001 */
const descriptionInput = z
  .string()
  .transform((value) => value.replace(/\r\n/g, '\n'))
  .refine(
    (value) =>
      !value.includes('\u0000') &&
      !/[\uD800-\uDFFF]/u.test(value) &&
      Array.from(value).length <= 2000,
  );
const managementCreateInput = z.strictObject({
  name: projectInput.shape.name,
  description: descriptionInput.default(''),
});
const managementSettingsInput = z.strictObject({
  name: projectInput.shape.name,
  description: descriptionInput,
});
async function managementInput(request: Request, create = false) {
  const parsed = (create ? managementCreateInput : managementSettingsInput).safeParse(
    await readJson(request),
  );
  if (!parsed.success)
    throw new InputError(400, 'Provide a valid project name and plain description.');
  return parsed.data;
}
function managementId(id: string): string {
  if (!uuid.safeParse(id).success) throw new ProjectError(404, 'NOT_FOUND', 'Project not found.');
  return id;
}

/** @id CODE-PMG-007 @implements REQ-PMG-002 REQ-PROJ-004 */
function projectVersion(match: string | undefined): number {
  if (!match) throw new ProjectError(428, 'VERSION_REQUIRED', 'If-Match is required.');
  if (!/^"[1-9]\d*"$/.test(match) || Number(match.slice(1, -1)) > 2147483647)
    throw new ProjectError(400, 'INVALID_VERSION', 'If-Match must be a quoted positive integer.');
  return Number(match.slice(1, -1));
}

/** @id CODE-ID-004 @implements REQ-ID-001 REQ-ID-002 REQ-ID-003 REQ-ID-004 */
export function createApp(options: {
  config: AppConfig;
  verifyToken: TokenVerifier;
  projects: ProjectRepository;
  copilot?: CopilotService;
  preferences?: PreferencesRepository;
  files?: FileService;
  jobs?: JobService;
  conversions?: ConversionRepository;
  chat?: ChatService;
  projectPins?: ProjectPinsRepository;
  projectOrder?: ProjectOrderRepository;
  notebook?: { pool: Pool; runtime: NotebookDriver; files?: FileService };
}) {
  const app = new Hono<Environment>();
  const notebook =
    options.config.notebookEnabled && options.notebook
      ? new NotebookService(
          new NotebookRepository(options.notebook.pool),
          options.notebook.runtime,
          options.notebook.files,
        )
      : undefined;
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    c.header('X-Request-ID', c.get('requestId'));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    /** @id CODE-MDV-007 @implements REQ-MDV-003 */
    c.header(
      'Content-Security-Policy',
      c.req.path === '/markdown-renderer.html'
        ? "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts"
        : `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://login.microsoftonline.com; frame-src https://login.microsoftonline.com ${options.config.publicOrigin}/markdown-renderer.html; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    if (c.req.path === '/markdown-assets/renderer.js') {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    c.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    await next();
    /** @id CODE-POP-001 @implements REQ-POP-001 */
    if (
      c.res.status === 200 &&
      (c.req.method === 'GET' || c.req.method === 'HEAD') &&
      new URL(c.req.url).pathname === '/auth-redirect.html'
    ) {
      c.header('Cross-Origin-Opener-Policy', 'unsafe-none');
    }
  });
  app.onError((_error, c) => {
    if (_error instanceof NotebookError)
      return failure(c, _error.status, 'NOTEBOOK_ERROR', _error.message);
    if (_error instanceof ProjectError)
      return failure(c, _error.status, _error.code, _error.message);
    if (_error instanceof ChatError) {
      if (_error.status >= 500)
        console.error(
          JSON.stringify({
            event: 'chat_request_failed',
            code: _error.code,
            requestId: c.get('requestId'),
          }),
        );
      return failure(c, _error.status, _error.code, _error.message);
    }
    if (_error instanceof JobError) {
      if (_error.status === 429) c.header('Retry-After', '1');
      if (_error.status >= 500)
        console.error(
          JSON.stringify({
            event: 'job_request_failed',
            code: _error.code,
            requestId: c.get('requestId'),
          }),
        );
      return failure(c, _error.status, _error.code, _error.message);
    }
    if (_error instanceof FileError) {
      if (_error.status === 429) c.header('Retry-After', '1');
      if (_error.status >= 500)
        console.error(
          JSON.stringify({
            event: 'file_request_failed',
            code: _error.code,
            requestId: c.get('requestId'),
          }),
        );
      return failure(c, _error.status, _error.code, _error.message);
    }
    if (_error instanceof CopilotError) {
      if (_error.retryAfter > 0) c.header('Retry-After', String(_error.retryAfter));
      if (_error.status >= 500)
        console.error(
          JSON.stringify({
            event: 'copilot_request_failed',
            code: _error.code,
            requestId: c.get('requestId'),
          }),
        );
      return failure(c, _error.status, _error.code, _error.message);
    }
    if (_error instanceof InputError)
      return failure(
        c,
        _error.status,
        _error.status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_INPUT',
        _error.message,
      );
    console.error(JSON.stringify({ event: 'request_failed', requestId: c.get('requestId') }));
    return failure(c, 500, 'INTERNAL_ERROR', 'The request could not be completed.');
  });
  app.get('/health/live', (c) => c.json({ status: 'live' }));
  app.get('/health/ready', async (c) => {
    try {
      await options.projects.ready();
      return c.json({ status: 'ready' });
    } catch {
      return failure(c, 503, 'NOT_READY', 'Database is unavailable.');
    }
  });
  app.get('/api/config', (c) => c.json(publicConfig(options.config)));
  app.use('/api/*', async (c, next) => {
    const bearer = /^Bearer ([^\s]+)$/i.exec(c.req.header('Authorization') ?? '');
    const result = bearer?.[1] ? await options.verifyToken(bearer[1]) : null;
    if (!result?.ok) {
      const status = result?.status ?? 401;
      if (status === 401) c.header('WWW-Authenticate', 'Bearer');
      return failure(
        c,
        status,
        result?.code ?? 'UNAUTHENTICATED',
        status === 401
          ? 'Authentication required.'
          : status === 403
            ? 'Access denied.'
            : 'Identity service is unavailable.',
      );
    }
    c.set('principal', result.principal);
    await next();
  });
  app.get('/api/me', (c) => c.json(c.get('principal')));
  /** @id CODE-SID-013 @implements REQ-SID-007 REQ-SID-009 */
  app.get('/api/project-order/capabilities', async (c) => {
    if (!options.config.projectOrderEnabled) return c.json({ enabled: false });
    if (!options.projectOrder) throw new Error('Project order repository unavailable.');
    await options.projectOrder.ready();
    return c.json({ enabled: true });
  });
  app.get('/api/project-order', async (c) => {
    if (!options.config.projectOrderEnabled)
      return failure(c, 503, 'PROJECT_ORDER_UNAVAILABLE', 'Project order is unavailable.');
    if (!options.projectOrder) throw new Error('Project order repository unavailable.');
    return c.json(
      projectOrderSnapshotSchema.parse(await options.projectOrder.get(c.get('principal'))),
    );
  });
  app.patch('/api/project-order', async (c) => {
    if (!options.config.projectOrderEnabled)
      return failure(c, 503, 'PROJECT_ORDER_UNAVAILABLE', 'Project order is unavailable.');
    if (!options.projectOrder) throw new Error('Project order repository unavailable.');
    const parsed = projectOrderMoveSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success) throw new InputError(400, 'Provide a group, project and distinct anchor.');
    const version = projectVersion(c.req.header('If-Match'));
    return c.json(
      projectOrderSnapshotSchema.parse(
        await options.projectOrder.move(c.get('principal'), version, parsed.data),
      ),
    );
  });
  /** @id CODE-PMG-002 @implements REQ-PMG-001 REQ-PMG-002 REQ-PMG-003 REQ-PMG-004 REQ-PMG-005 */
  app.get('/api/project-management/capabilities', async (c) => {
    if (options.config.projectManagementEnabled) await options.projects.managementReady();
    return c.json({ enabled: options.config.projectManagementEnabled === true });
  });
  app.use('/api/project-management/*', async (c, next) => {
    if (!options.config.projectManagementEnabled)
      return failure(
        c,
        503,
        'PROJECT_MANAGEMENT_UNAVAILABLE',
        'Project management is unavailable.',
      );
    await options.projects.managementReady();
    await next();
  });
  app.post('/api/project-management/projects', async (c) => {
    const input = await managementInput(c.req.raw, true);
    const result = await options.projects.createManaged(
      c.get('principal'),
      input.name,
      input.description,
    );
    c.header('ETag', `"${result.project.version}"`);
    return c.json(result, 201);
  });
  app.get('/api/project-management/trash', async (c) =>
    c.json({ items: await options.projects.listTrashed(c.get('principal')) }),
  );
  app.get('/api/project-management/projects/:id', async (c) => {
    const result = await options.projects.getManaged(
      c.get('principal'),
      managementId(c.req.param('id')),
    );
    if (!result) throw new ProjectError(404, 'NOT_FOUND', 'Project not found.');
    c.header('ETag', `"${result.project.version}"`);
    return c.json(result);
  });
  app.patch('/api/project-management/projects/:id', async (c) => {
    const input = await managementInput(c.req.raw);
    const id = managementId(c.req.param('id'));
    const version = projectVersion(c.req.header('If-Match'));
    const result = await options.projects.editManaged(
      c.get('principal'),
      id,
      input.name,
      input.description,
      version,
    );
    c.header('ETag', `"${result.project.version}"`);
    return c.json(result);
  });
  for (const action of ['trash', 'restore'] as const) {
    app.post(`/api/project-management/projects/:id/${action}`, async (c) => {
      if (!z.strictObject({}).safeParse(await readJson(c.req.raw)).success)
        throw new InputError(400, 'Provide an empty JSON object.');
      const id = managementId(c.req.param('id'));
      const version = projectVersion(c.req.header('If-Match'));
      const change = () => options.projects[action](c.get('principal'), id, version);
      const result =
        action === 'trash' && notebook
          ? await notebook.trash(c.get('principal'), id, change)
          : await change();
      c.header('ETag', `"${result.project.version}"`);
      return c.json(result);
    });
  }
  /** @id CODE-SID-003 @implements REQ-SID-001 REQ-SID-002 */
  app.get('/api/project-pins', async (c) => {
    if (!options.config.projectPinsEnabled || !options.projectPins)
      return failure(c, 503, 'PROJECT_PINS_UNAVAILABLE', 'Project pins are unavailable.');
    return c.json(
      projectPinsSchema.parse({ projectIds: await options.projectPins.list(c.get('principal')) }),
    );
  });
  app.put('/api/projects/:id/pin', async (c) => {
    if (!options.config.projectPinsEnabled || !options.projectPins)
      return failure(c, 503, 'PROJECT_PINS_UNAVAILABLE', 'Project pins are unavailable.');
    const id = c.req.param('id');
    const principal = c.get('principal');
    if (!uuid.safeParse(id).success || !(await options.projects.get(principal, id)))
      return failure(c, 404, 'NOT_FOUND', 'Project not found.');
    const parsed = projectPinInputSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success) throw new InputError(400, 'Provide only pinned as a boolean.');
    if (!(await options.projectPins.set(principal, id, parsed.data.pinned)))
      return failure(c, 404, 'NOT_FOUND', 'Project not found.');
    return c.json(
      projectPinsSchema.parse({ projectIds: await options.projectPins.list(principal) }),
    );
  });
  /** @id CODE-FONT-005 @implements REQ-FONT-001 REQ-FONT-002 */
  app.get('/api/settings/text-size', async (c) => {
    if (!options.config.textSizeEnabled)
      return failure(c, 503, 'TEXT_SIZE_UNAVAILABLE', 'Text size is unavailable.');
    if (!options.preferences) throw new Error('Text-size storage is unavailable.');
    return c.json(await options.preferences.getTextSize(c.get('principal')));
  });
  app.patch('/api/settings/text-size', async (c) => {
    if (!options.config.textSizeEnabled)
      return failure(c, 503, 'TEXT_SIZE_UNAVAILABLE', 'Text size is unavailable.');
    const parsed = textSizeSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success)
      throw new InputError(400, 'Provide size large, medium, small or extra-small only.');
    if (!options.preferences) throw new Error('Text-size storage is unavailable.');
    return c.json(await options.preferences.patchTextSize(c.get('principal'), parsed.data));
  });
  app.get('/api/settings/preferences', async (c) => {
    if (!options.preferences)
      return failure(c, 503, 'PREFERENCES_UNAVAILABLE', 'Preferences are unavailable.');
    return c.json(await options.preferences.get(c.get('principal')));
  });
  app.patch('/api/settings/preferences', async (c) => {
    const parsed = preferencePatchSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success)
      throw new InputError(400, 'Provide language ja/en and/or theme light/dark only.');
    if (!options.preferences)
      return failure(c, 503, 'PREFERENCES_UNAVAILABLE', 'Preferences are unavailable.');
    return c.json(await options.preferences.patch(c.get('principal'), parsed.data));
  });
  const connection = () => {
    if (!options.copilot)
      throw new CopilotError(
        503,
        'COPILOT_NOT_CONFIGURED',
        'GitHub connection is not configured. Contact the administrator.',
      );
    return options.copilot;
  };
  const attemptId = (id: string) => {
    if (!options.copilot || !uuid.safeParse(id).success)
      throw new CopilotError(404, 'NOT_FOUND', 'Connection attempt not found.');
    return id.toLowerCase();
  };
  app.use('/api/settings/copilot/*', async (c, next) => {
    if (c.req.raw.body) {
      await c.req.raw.body.cancel();
      throw new InputError(400, 'This endpoint does not accept a request body.');
    }
    await next();
  });
  /** @id CODE-CON-006 @implements REQ-CON-002 REQ-CON-003 REQ-CON-004 */
  app.get('/api/settings/copilot', async (c) =>
    c.json(
      options.copilot
        ? await options.copilot.status(c.get('principal'))
        : { configured: false, status: 'disconnected', attempt: null },
    ),
  );
  app.post('/api/settings/copilot/attempts', async (c) =>
    c.json(await connection().start(c.get('principal')), 201),
  );
  app.post('/api/settings/copilot/attempts/:id/poll', async (c) => {
    const id = attemptId(c.req.param('id'));
    return c.json(await connection().poll(c.get('principal'), id));
  });
  app.delete('/api/settings/copilot/attempts/:id', async (c) => {
    const id = attemptId(c.req.param('id'));
    return c.json(await connection().cancel(c.get('principal'), id));
  });
  app.delete('/api/settings/copilot', async (c) => {
    await connection().disconnect(c.get('principal'));
    return c.body(null, 204);
  });
  /** @id CODE-PROJ-004 @implements REQ-PROJ-001 REQ-PROJ-002 REQ-PROJ-004 */
  app.get('/api/projects', async (c) => c.json(await options.projects.list(c.get('principal'))));
  app.post('/api/projects', async (c) => {
    const name = await projectName(c.req.raw);
    return c.json(await options.projects.create(c.get('principal'), name), 201);
  });
  app.get('/api/projects/:id', async (c) => {
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success) return failure(c, 404, 'NOT_FOUND', 'Project not found.');
    const found = await options.projects.get(c.get('principal'), id);
    if (!found) return failure(c, 404, 'NOT_FOUND', 'Project not found.');
    c.header('ETag', `"${found.version}"`);
    return c.json(found);
  });
  app.patch('/api/projects/:id', async (c) => {
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success || !(await options.projects.get(c.get('principal'), id))) {
      return failure(c, 404, 'NOT_FOUND', 'Project not found.');
    }
    const version = projectVersion(c.req.header('If-Match'));
    const name = await projectName(c.req.raw);
    const updated = await options.projects.rename(c.get('principal'), id, name, version);
    if (!updated) return failure(c, 404, 'NOT_FOUND', 'Project not found.');
    if (updated === 'conflict')
      return failure(c, 409, 'VERSION_CONFLICT', 'Project changed. Reload before renaming.');
    c.header('ETag', `"${updated.version}"`);
    return c.json(updated);
  });
  /** @id CODE-SVC-017 @implements REQ-SVC-003 REQ-SVC-010 REQ-SVC-011 REQ-SVC-014 */
  app.use('/api/projects/:id/jobs/*', async (c, next) => {
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success || !(await options.projects.get(c.get('principal'), id)))
      throw new JobError(404, 'NOT_FOUND', 'Job or project not found.');
    await next();
  });
  app.use('/api/projects/:id/jobs/:jobId/*', async (c, next) => {
    if (!uuid.safeParse(c.req.param('jobId')).success)
      throw new JobError(404, 'NOT_FOUND', 'Job or project not found.');
    await next();
  });
  const jobs = () => {
    if (!options.jobs) throw new JobError(503, 'JOBS_UNAVAILABLE', 'Jobs are disabled.');
    return options.jobs;
  };
  app.use('/api/projects/:id/jobs/*', async (_c, next) => {
    jobs();
    await next();
  });
  app.post('/api/projects/:id/jobs', async (c) => {
    const result = await jobs().enqueue(
      c.get('principal'),
      c.req.param('id'),
      c.req.header('Idempotency-Key'),
      await readJson(c.req.raw),
    );
    return c.json(result.job, result.created ? 201 : 200);
  });
  app.get('/api/projects/:id/jobs', async (c) => {
    const query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some((key) => key !== 'cursor') || query.getAll('cursor').length > 1)
      throw new JobError(400, 'INVALID_QUERY', 'Only one cursor parameter is allowed.');
    return c.json(
      await jobs().repository.list(
        c.get('principal'),
        c.req.param('id'),
        query.get('cursor') ?? undefined,
      ),
    );
  });
  app.get('/api/projects/:id/jobs/:jobId', async (c) =>
    c.json(
      await jobs().repository.get(c.get('principal'), c.req.param('id'), c.req.param('jobId')),
    ),
  );
  app.post('/api/projects/:id/jobs/:jobId/cancel', async (c) => {
    await jobs().repository.get(c.get('principal'), c.req.param('id'), c.req.param('jobId'));
    if (c.req.raw.body) {
      const reader = c.req.raw.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          if (part.value.byteLength > 0) {
            await reader.cancel();
            throw new JobError(400, 'INVALID_JOB', 'Cancellation does not accept a body.');
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    return c.json(
      await jobs().repository.cancel(c.get('principal'), c.req.param('id'), c.req.param('jobId')),
    );
  });
  registerChatRoutes(app, {
    projects: options.projects,
    enabled: options.config.chatEnabled === true,
    ...(options.chat ? { service: options.chat } : {}),
  });
  registerNotebookRoutes(app, {
    projects: options.projects,
    enabled: options.config.notebookEnabled === true,
    origin: options.config.publicOrigin,
    ...(notebook ? { service: notebook } : {}),
  });
  registerConversionRoutes(app, {
    projects: options.projects,
    enabled: options.config.conversion !== undefined,
    ...(options.conversions ? { repository: options.conversions } : {}),
  });
  /** @id CODE-SVC-006 @implements REQ-SVC-001 REQ-SVC-004 REQ-SVC-006 */
  app.use('/api/projects/:id/files/*', async (c, next) => {
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success || !(await options.projects.get(c.get('principal'), id)))
      throw new FileError(404, 'NOT_FOUND', 'Project not found.');
    if (!options.files)
      throw new FileError(503, 'FILES_UNAVAILABLE', 'File storage is not configured.');
    await next();
  });
  const files = () => {
    if (!options.files)
      throw new FileError(503, 'FILES_UNAVAILABLE', 'File storage is not configured.');
    return options.files;
  };
  /** @id CODE-FEX-004 @implements REQ-FEX-002 */
  app.get('/api/projects/:id/files', async (c) => {
    const trashed = c.req.query('trashed');
    if (trashed !== undefined && trashed !== 'true')
      throw new FileError(400, 'INVALID_FILE_VIEW', 'Invalid file view.');
    return c.json(
      await files().list(
        c.get('principal'),
        c.req.param('id'),
        c.req.query('cursor'),
        trashed === 'true',
      ),
    );
  });
  /** @id CODE-FTP-004 @implements REQ-FTP-002 REQ-FTP-003 */
  app.delete('/api/projects/:id/files/trash', async (c) => {
    await files().emptyTrash(c.get('principal'), c.req.param('id'), c.req.raw.signal);
    return c.body(null, 204);
  });
  app.delete('/api/projects/:id/files/:fileId', async (c) => {
    await files().setTrashed(c.get('principal'), c.req.param('id'), c.req.param('fileId'), true);
    return c.body(null, 204);
  });
  app.post('/api/projects/:id/files/:fileId/restore', async (c) => {
    await files().setTrashed(c.get('principal'), c.req.param('id'), c.req.param('fileId'), false);
    return c.body(null, 204);
  });
  app.post('/api/projects/:id/files', async (c) => {
    let name: string;
    try {
      name = decodeURIComponent(c.req.header('X-File-Name') ?? '');
    } catch {
      throw new FileError(400, 'INVALID_FILE', 'Invalid encoded file name.');
    }
    const declared = c.req.header('X-File-Size') ?? '';
    if (!/^(?:0|[1-9]\d*)$/.test(declared))
      throw new FileError(400, 'INVALID_FILE', 'A decimal file byte size is required.');
    return c.json(
      await files().upload(
        c.get('principal'),
        c.req.param('id'),
        { name, size: Number(declared) },
        c.req.raw.body,
        c.req.raw.signal,
      ),
      201,
    );
  });
  app.get('/api/projects/:id/files/:fileId/content', async (c) => {
    const result = await files().open(
      c.get('principal'),
      c.req.param('id'),
      c.req.param('fileId'),
      c.req.raw.signal,
    );
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Length', String(result.file.size));
    c.header(
      'Content-Disposition',
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(result.file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    );
    return new Response(result.body, { headers: c.res.headers });
  });
  app.notFound((c) => failure(c, 404, 'NOT_FOUND', 'Project not found.'));
  return app;
}
