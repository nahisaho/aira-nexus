import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Principal, Project } from '../shared/contracts.js';

interface ProjectRow {
  id: string;
  name: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const project = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

interface ManagedProjectRow extends ProjectRow {
  description: string;
  trashed_at: Date | null;
}
export interface ProjectDetails {
  project: Project;
  description: string;
  trashedAt: string | null;
}
const details = (row: ManagedProjectRow): ProjectDetails => ({
  project: project(row),
  description: row.description,
  trashedAt: row.trashed_at?.toISOString() ?? null,
});
const managedColumns = 'id,name,version,created_at,updated_at,description,trashed_at';

/** @id CODE-PMG-004 @implements REQ-PMG-004 */
export function activeProjectPredicate(alias: 'projects' | 'project' | 'p' = 'projects'): string {
  return `(to_jsonb(${alias})->>'trashed_at') IS NULL`;
}

export class ProjectError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 428,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const missingProject = () => new ProjectError(404, 'NOT_FOUND', 'Project not found.');
const versionConflict = () =>
  new ProjectError(409, 'VERSION_CONFLICT', 'Project changed. Reload before updating.');

/** @id CODE-PROJ-001 @implements REQ-PROJ-001 REQ-PROJ-002 REQ-PROJ-004 */
export class ProjectRepository {
  constructor(private readonly pool: Pool) {}

  async list(owner: Principal): Promise<Project[]> {
    const { rows } = await this.pool.query<ProjectRow>(
      `SELECT id, name, version, created_at, updated_at FROM projects WHERE tenant_id=$1 AND owner_oid=$2 AND ${activeProjectPredicate()} ORDER BY updated_at DESC, id ASC`,
      [owner.tenantId, owner.objectId],
    );
    return rows.map(project);
  }

  async create(owner: Principal, name: string): Promise<Project> {
    const { rows } = await this.pool.query<ProjectRow>(
      'INSERT INTO projects(id, tenant_id, owner_oid, name) VALUES($1,$2,$3,$4) RETURNING id, name, version, created_at, updated_at',
      [randomUUID(), owner.tenantId, owner.objectId, name],
    );
    if (!rows[0]) throw new Error('Project insert returned no row.');
    return project(rows[0]);
  }

  async get(owner: Principal, id: string): Promise<Project | undefined> {
    const { rows } = await this.pool.query<ProjectRow>(
      `SELECT id, name, version, created_at, updated_at FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()}`,
      [id, owner.tenantId, owner.objectId],
    );
    return rows[0] ? project(rows[0]) : undefined;
  }

  async rename(
    owner: Principal,
    id: string,
    name: string,
    version: number,
  ): Promise<Project | 'conflict' | undefined> {
    const { rows } = await this.pool.query<ProjectRow>(
      `UPDATE projects SET name=$4, version=version+1, updated_at=GREATEST(clock_timestamp(), updated_at) WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND version=$5 AND version<2147483647 AND ${activeProjectPredicate()} RETURNING id, name, version, created_at, updated_at`,
      [id, owner.tenantId, owner.objectId, name, version],
    );
    if (rows[0]) return project(rows[0]);
    return (await this.get(owner, id)) ? 'conflict' : undefined;
  }

  /** @id CODE-PMG-006 @implements REQ-PMG-005 */
  async managementReady(): Promise<void> {
    await this.pool.query('SELECT description, trashed_at FROM projects LIMIT 0');
  }

  /** @id CODE-PMG-001 @implements REQ-PMG-001 REQ-PMG-002 REQ-PMG-003 */
  async createManaged(
    owner: Principal,
    name: string,
    description: string,
  ): Promise<ProjectDetails> {
    const { rows } = await this.pool.query<ManagedProjectRow>(
      `INSERT INTO projects(id,tenant_id,owner_oid,name,description) VALUES($1,$2,$3,$4,$5) RETURNING ${managedColumns}`,
      [randomUUID(), owner.tenantId, owner.objectId, name, description],
    );
    if (!rows[0]) throw new Error('Project insert returned no row.');
    return details(rows[0]);
  }

  async getManaged(owner: Principal, id: string): Promise<ProjectDetails | undefined> {
    const { rows } = await this.pool.query<ManagedProjectRow>(
      `SELECT ${managedColumns} FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()}`,
      [id, owner.tenantId, owner.objectId],
    );
    return rows[0] ? details(rows[0]) : undefined;
  }

  async listTrashed(owner: Principal): Promise<ProjectDetails[]> {
    const { rows } = await this.pool.query<ManagedProjectRow>(
      `SELECT ${managedColumns} FROM projects WHERE tenant_id=$1 AND owner_oid=$2 AND trashed_at IS NOT NULL ORDER BY updated_at DESC,id ASC`,
      [owner.tenantId, owner.objectId],
    );
    return rows.map(details);
  }

  async editManaged(
    owner: Principal,
    id: string,
    name: string,
    description: string,
    version: number,
  ): Promise<ProjectDetails> {
    return this.changeManagement(owner, id, version, { kind: 'settings', name, description });
  }

  async trash(owner: Principal, id: string, version: number): Promise<ProjectDetails> {
    return this.changeManagement(owner, id, version, { kind: 'trash' });
  }

  async restore(owner: Principal, id: string, version: number): Promise<ProjectDetails> {
    return this.changeManagement(owner, id, version, { kind: 'restore' });
  }

  private async busy(client: PoolClient, id: string): Promise<boolean> {
    const { rows } = await client.query<{ jobs: boolean; files: boolean }>(
      "SELECT to_regclass('durable_jobs') IS NOT NULL AS jobs,to_regclass('project_files') IS NOT NULL AS files",
    );
    const tables = rows[0];
    if (!tables) throw new Error('Project activity schema query returned no row.');
    if (tables.jobs) {
      const { rows } = await client.query<{ busy: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM durable_jobs WHERE project_id=$1 AND state IN ('queued','running','cancel_requested')) AS busy",
        [id],
      );
      if (!rows[0]) throw new Error('Project job activity query returned no row.');
      if (rows[0].busy) return true;
    }
    if (tables.files) {
      const { rows } = await client.query<{ busy: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM project_files WHERE project_id=$1 AND state='uploading' AND expires_at>clock_timestamp()) AS busy",
        [id],
      );
      if (!rows[0]) throw new Error('Project upload activity query returned no row.');
      if (rows[0].busy) return true;
    }
    return false;
  }

  private async changeManagement(
    owner: Principal,
    id: string,
    version: number,
    action: { kind: 'settings'; name: string; description: string } | { kind: 'trash' | 'restore' },
  ): Promise<ProjectDetails> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const { rows } = await client.query<ManagedProjectRow>(
        `WITH job_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(1747289124))
         SELECT p.* FROM projects p CROSS JOIN job_lock
         WHERE p.id=$1 AND p.tenant_id=$2 AND p.owner_oid=$3
           AND ${action.kind === 'settings' ? activeProjectPredicate('p') : 'TRUE'}
         FOR UPDATE OF p`,
        [id, owner.tenantId, owner.objectId],
      );
      const current = rows[0];
      if (!current) throw missingProject();
      if (current.version !== version || version === 2147483647) throw versionConflict();
      if (
        (action.kind === 'trash' && current.trashed_at !== null) ||
        (action.kind === 'restore' && current.trashed_at === null)
      )
        throw new ProjectError(409, 'PROJECT_STATE_CONFLICT', 'Project state changed.');
      if (action.kind === 'trash' && (await this.busy(client, id)))
        throw new ProjectError(409, 'PROJECT_BUSY', 'Project has active jobs or uploads.');
      const updated =
        action.kind === 'settings'
          ? await client.query<ManagedProjectRow>(
              `UPDATE projects SET name=$4,description=$5,version=version+1,
                 updated_at=GREATEST(clock_timestamp(),updated_at)
               WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND version=$6
               RETURNING ${managedColumns}`,
              [id, owner.tenantId, owner.objectId, action.name, action.description, version],
            )
          : await client.query<ManagedProjectRow>(
              `UPDATE projects SET trashed_at=${action.kind === 'trash' ? 'clock_timestamp()' : 'NULL'},
                 version=version+1,updated_at=GREATEST(clock_timestamp(),updated_at)
               WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND version=$4
               RETURNING ${managedColumns}`,
              [id, owner.tenantId, owner.objectId, version],
            );
      if (!updated.rows[0]) throw versionConflict();
      await client.query('COMMIT');
      return details(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ready(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
