import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Environment } from '../app.js';
import type { ProjectRepository } from '../projects.js';
import { uuid } from '../config.js';
import { InputError, readJson } from '../http-input.js';
import type { ChatService } from './service.js';
import { chatUnavailable } from './errors.js';
import { chatEventStream } from './stream.js';

const emptyObject = z.strictObject({});
const discoverySchema = z.strictObject({ confirmed: z.literal(true) });

function failure(c: Context<Environment>, status: 404 | 503, code: string, message: string) {
  return c.json({ error: { code, message, requestId: c.get('requestId') } }, status);
}

function queryParameter(url: string, name: string): string | undefined {
  const query = new URL(url).searchParams;
  if ([...query.keys()].some((key) => key !== name) || query.getAll(name).length > 1)
    throw new InputError(400, `Only one ${name} parameter is allowed.`);
  return query.get(name) ?? undefined;
}

function requireNoQuery(url: string): void {
  if ([...new URL(url).searchParams.keys()].length)
    throw new InputError(400, 'This request does not accept query parameters.');
}

function eventSequence(url: string): number {
  const value = queryParameter(url, 'after') ?? '0';
  if (!/^(0|[1-9]\d{0,9})$/.test(value) || Number(value) > 2147483647)
    throw new InputError(400, 'Provide a canonical non-negative sequence.');
  return Number(value);
}

async function requireNoBody(request: Request): Promise<void> {
  const reader = request.body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      if (part.value.byteLength > 0) {
        await reader.cancel();
        throw new InputError(400, 'This request does not accept a body.');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function registerChatRoutes(
  app: Hono<Environment>,
  options: {
    projects: ProjectRepository;
    enabled: boolean;
    service?: ChatService;
  },
): void {
  const capabilitiesPath = (path: string) => path.endsWith('/chat/capabilities');
  const service = () => {
    if (!options.service) throw chatUnavailable();
    return options.service;
  };
  app.use('/api/projects/:id/chat/*', async (c, next) => {
    const project = c.req.param('id');
    if (
      !uuid.safeParse(project).success ||
      !(await options.projects.get(c.get('principal'), project))
    )
      return failure(c, 404, 'NOT_FOUND', 'Project not found.');
    if (c.req.method === 'GET' && capabilitiesPath(c.req.path)) return next();
    if (!options.enabled) return failure(c, 503, 'CHAT_UNAVAILABLE', 'Chat is unavailable.');
    if (!options.service) throw chatUnavailable();
    await options.service.ready();
    return next();
  });

  app.get('/api/projects/:id/chat/capabilities', async (c) => {
    requireNoQuery(c.req.url);
    if (!options.enabled) return c.json({ enabled: false });
    await service().ready();
    return c.json({ enabled: true });
  });

  app.post('/api/projects/:id/chat/models', async (c) => {
    requireNoQuery(c.req.url);
    const body = discoverySchema.safeParse(await readJson(c.req.raw));
    if (!body.success) throw new InputError(400, 'Confirm account-only model discovery.');
    return c.json(
      await service().discoverModels(c.get('principal'), c.req.param('id'), body.data.confirmed),
    );
  });

  app.post('/api/projects/:id/chat/conversations', async (c) => {
    requireNoQuery(c.req.url);
    if (!emptyObject.safeParse(await readJson(c.req.raw)).success)
      throw new InputError(400, 'Provide an empty JSON object.');
    const created = await service().repository.createConversation(
      c.get('principal'),
      c.req.param('id'),
    );
    return c.json(created, 201);
  });

  app.get('/api/projects/:id/chat/conversations', async (c) => {
    const cursor = queryParameter(c.req.url, 'cursor');
    return c.json(
      await service().repository.listConversations(c.get('principal'), c.req.param('id'), cursor),
    );
  });

  app.get('/api/projects/:id/chat/conversations/:conversationId', async (c) => {
    requireNoQuery(c.req.url);
    return c.json(
      await service().repository.getConversation(
        c.get('principal'),
        c.req.param('id'),
        c.req.param('conversationId'),
      ),
    );
  });

  app.get('/api/projects/:id/chat/conversations/:conversationId/turns', async (c) => {
    const cursor = queryParameter(c.req.url, 'cursor');
    return c.json(
      await service().repository.listTurns(
        c.get('principal'),
        c.req.param('id'),
        c.req.param('conversationId'),
        cursor,
      ),
    );
  });

  app.post('/api/projects/:id/chat/conversations/:conversationId/previews', async (c) => {
    requireNoQuery(c.req.url);
    return c.json(
      await service().createPreview(
        c.get('principal'),
        c.req.param('id'),
        c.req.param('conversationId'),
        await readJson(c.req.raw),
      ),
      201,
    );
  });

  app.post('/api/projects/:id/chat/conversations/:conversationId/runs', async (c) => {
    requireNoQuery(c.req.url);
    return c.json(
      await service().confirmPreview(
        c.get('principal'),
        c.req.param('id'),
        c.req.param('conversationId'),
        await readJson(c.req.raw),
        c.req.header('Idempotency-Key') ?? null,
      ),
      202,
    );
  });

  app.get('/api/projects/:id/chat/runs/:runId', async (c) => {
    requireNoQuery(c.req.url);
    return c.json(
      await service().repository.getRun(
        c.get('principal'),
        c.req.param('id'),
        c.req.param('runId'),
      ),
    );
  });

  app.get('/api/projects/:id/chat/runs/:runId/events', async (c) => {
    return c.json(
      await service().repository.listEvents(
        c.get('principal'),
        c.req.param('id'),
        c.req.param('runId'),
        eventSequence(c.req.url),
      ),
    );
  });

  app.get('/api/projects/:id/chat/runs/:runId/stream', (c) => {
    const repository = service().repository;
    const owner = c.get('principal');
    const project = c.req.param('id');
    const runId = c.req.param('runId');
    return chatEventStream(eventSequence(c.req.url), c.req.raw.signal, (after) =>
      repository.listEvents(owner, project, runId, after),
    );
  });

  app.post('/api/projects/:id/chat/runs/:runId/cancel', async (c) => {
    requireNoQuery(c.req.url);
    await requireNoBody(c.req.raw);
    return c.json(
      await service().repository.cancelRun(
        c.get('principal'),
        c.req.param('id'),
        c.req.param('runId'),
      ),
    );
  });
}
