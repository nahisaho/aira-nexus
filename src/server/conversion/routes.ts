import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Environment } from '../app.js';
import type { ProjectRepository } from '../projects.js';
import type { ConversionRepository } from './repository.js';
import { FileError } from '../files/service.js';
import { InputError, readJson } from '../http-input.js';
import { conversionBodySchema } from './service.js';
import { conversionPageSchema, conversionRequestSchema } from '../../shared/conversions.js';

export function registerConversionRoutes(
  app: Hono<Environment>,
  options: {
    projects: ProjectRepository;
    enabled: boolean;
    repository?: ConversionRepository;
  },
) {
  const missing = () => new FileError(404, 'NOT_FOUND', 'Conversion, source or project not found.');
  async function authorize(c: Context<Environment>, resourceId?: string) {
    const project = c.req.param('id');
    if (
      !project ||
      !z.uuid().safeParse(project).success ||
      !(await options.projects.get(c.get('principal'), project)) ||
      (resourceId !== undefined && !z.uuid().safeParse(resourceId).success)
    )
      throw missing();
    return project;
  }
  function repository() {
    if (!options.enabled || !options.repository)
      throw new FileError(
        503,
        'DOCUMENT_CONVERSION_UNAVAILABLE',
        'Document conversion is unavailable.',
      );
    return options.repository;
  }
  app.get('/api/projects/:id/conversions/capabilities', async (c) => {
    await authorize(c);
    if (!options.enabled) return c.json({ enabled: false });
    await repository().ready();
    return c.json({ enabled: true });
  });
  app.post('/api/projects/:id/files/:fileId/conversions', async (c) => {
    const project = await authorize(c, c.req.param('fileId'));
    const conversions = repository();
    await conversions.authorizeSource(c.get('principal'), project, c.req.param('fileId'));
    if (!conversionBodySchema.safeParse(await readJson(c.req.raw)).success)
      throw new InputError(400, 'Conversion requires an empty JSON object.');
    const result = await conversions.request(
      c.get('principal'),
      project,
      c.req.param('fileId'),
      c.req.header('Idempotency-Key'),
    );
    return c.json(conversionRequestSchema.parse(result.request), result.created ? 202 : 200);
  });
  app.get('/api/projects/:id/conversions', async (c) => {
    const project = await authorize(c);
    const conversions = repository();
    const query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some((key) => key !== 'cursor') || query.getAll('cursor').length > 1)
      throw new InputError(400, 'Only one cursor parameter is allowed.');
    return c.json(
      conversionPageSchema.parse(
        await conversions.list(c.get('principal'), project, query.get('cursor') ?? undefined),
      ),
    );
  });
  app.get('/api/projects/:id/conversions/:conversionId', async (c) => {
    const project = await authorize(c, c.req.param('conversionId'));
    return c.json(
      conversionRequestSchema.parse(
        await repository().get(c.get('principal'), project, c.req.param('conversionId')),
      ),
    );
  });
  app.post('/api/projects/:id/conversions/:conversionId/cancel', async (c) => {
    const project = await authorize(c, c.req.param('conversionId'));
    const conversions = repository();
    await conversions.get(c.get('principal'), project, c.req.param('conversionId'));
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (next.value.byteLength) {
            await reader.cancel();
            throw new InputError(400, 'Cancellation does not accept a body.');
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    return c.json(
      conversionRequestSchema.parse(
        await conversions.cancel(c.get('principal'), project, c.req.param('conversionId')),
      ),
    );
  });
}
