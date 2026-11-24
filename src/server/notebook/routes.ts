import type { Hono } from 'hono';
import { z } from 'zod';
import type { Environment } from '../app.js';
import type { ProjectRepository } from '../projects.js';
import { uuid } from '../config.js';
import { InputError } from '../http-input.js';
import { NOTEBOOK_CODE_BYTES, notebookCreate, notebookSave, notebookExecute, notebookLanguage } from '../../shared/notebook.js';
import { NotebookError, notebookUnavailable } from './repository.js';
import type { NotebookService } from './service.js';

async function body(request: Request) {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') throw new InputError(400,'JSON is required.');
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (reader) for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > NOTEBOOK_CODE_BYTES*6+4096) { await reader.cancel(); throw new InputError(413,'Notebook request is too large.'); }
      chunks.push(next.value);
    }
  } finally { reader?.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); }
  catch { throw new InputError(400,'Invalid JSON.'); }
  if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' && Buffer.byteLength(value.code) > NOTEBOOK_CODE_BYTES) throw new InputError(413,'Cell code exceeds 262144 bytes.');
  return value;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new InputError(400,'Invalid Notebook input.');
  return result.data;
}

/** @id CODE-NB-006 @implements REQ-NB-002 REQ-NB-004 */
export function registerNotebookRoutes(app: Hono<Environment>, options: {
  enabled: boolean; origin: string; projects: ProjectRepository; service?: NotebookService;
}) {
  const service = () => { if (!options.service) throw notebookUnavailable(); return options.service; };
  app.use('/api/projects/:id/notebook/*',async (c,next) => {
    const project = c.req.param('id');
    if (!uuid.safeParse(project).success || !(await options.projects.get(c.get('principal'),project))) throw new NotebookError(404,'Project not found.');
    const origin = c.req.header('Origin');
    if ((origin && origin !== options.origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') throw new InputError(400,'Same-origin requests are required.');
    if (new URL(c.req.url).search) throw new InputError(400,'Notebook does not accept query parameters.');
    if (!c.req.path.endsWith('/capabilities') && !options.enabled) throw notebookUnavailable();
    await next();
  });
  app.get('/api/projects/:id/notebook/capabilities',c=>c.json({enabled:options.enabled && !!options.service}));
  app.get('/api/projects/:id/notebook',async c=>c.json(await service().repository.list(c.get('principal'),c.req.param('id'))));
  app.post('/api/projects/:id/notebook/cells',async c=>{
    const input = parse(notebookCreate,await body(c.req.raw));
    return c.json(await service().repository.create(c.get('principal'),c.req.param('id'),input.language,input.code),201);
  });
  app.put('/api/projects/:id/notebook/cells/:cell',async c=>{
    if (!uuid.safeParse(c.req.param('cell')).success) throw new NotebookError(404,'Cell not found.');
    const input = parse(notebookSave,await body(c.req.raw));
    return c.json(await service().repository.save(c.get('principal'),c.req.param('id'),c.req.param('cell'),input.version,input.code));
  });
  app.post('/api/projects/:id/notebook/cells/:cell/execute',async c=>{
    if (!uuid.safeParse(c.req.param('cell')).success) throw new NotebookError(404,'Cell not found.');
    const input = parse(notebookExecute,await body(c.req.raw));
    const handler = service().handlers.get('notebook.execute');
    if (!handler) throw notebookUnavailable();
    return c.json(await handler(c.get('principal'),c.req.param('id'),c.req.param('cell'),input.version,input.files));
  });
  app.post('/api/projects/:id/notebook/restart',async c=>{
    const input = parse(z.strictObject({language:notebookLanguage}),await body(c.req.raw));
    return c.json(await service().restart(c.get('principal'),c.req.param('id'),input.language));
  });
  app.post('/api/projects/:id/notebook/artifacts',async c=>{
    const input = parse(z.strictObject({language:notebookLanguage,name:z.string()}),await body(c.req.raw));
    return c.json(await service().artifact(c.get('principal'),c.req.param('id'),input.language,input.name),201);
  });
}
