import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { ProjectRepository } from '../../src/server/projects.js';
import { config, identityFixture } from './identity.js';
import { testDatabase } from './database.js';

type Language = 'python' | 'r';
type Kernel = { project: string; language: Language; generation: string; token: string };
export class NotebookTestDriver {
  states = new Map<string, number>();
  files = new Map<string, Uint8Array>();
  ready = vi.fn(async () => {});
  start = vi.fn(async () => {});
  stop = vi.fn(async (kernel: Kernel) => {
    this.states.delete(`${kernel.project}/${kernel.language}`);
  });
  exists = vi.fn(async () => true);
  execute = vi.fn(async (kernel: Kernel, code: string) => {
    const key = `${kernel.project}/${kernel.language}`;
    const assignment = /x\s*(?:=|<-)\s*(\d+)/.exec(code);
    if (assignment) this.states.set(key, Number(assignment[1]));
    return String(this.states.get(key) ?? 'undefined');
  });
  artifact = vi.fn(async (_kernel: Kernel, name: string) => {
    const value = this.files.get(name);
    if (!value) throw new Error('Artifact unavailable.');
    return value;
  });
}

export async function notebookFixture(enabled = true) {
  const db = await testDatabase();
  const projects = new ProjectRepository(db.pool);
  const identity = await identityFixture();
  const owner = { tenantId: config.tenantId, objectId: randomUUID() };
  const token = await identity.sign({ oid: owner.objectId });
  const foreignToken = await identity.sign({ oid: randomUUID() });
  const runtime = new NotebookTestDriver();
  const app = createApp({
    config: { ...config, ...{ notebookEnabled: enabled } },
    projects,
    verifyToken: identity.verify,
    ...{ notebook: { pool: db.pool, runtime } },
  });
  const request = async (
    project: string,
    path = '',
    method = 'GET',
    body?: unknown,
    bearer = token,
  ) =>
    app.request(`/api/projects/${project}/notebook${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Origin: config.publicOrigin,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { db, projects, owner, token, foreignToken, runtime, app, request };
}
