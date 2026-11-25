import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Principal } from '../../shared/contracts.js';
import type { NotebookCell, NotebookLanguage } from '../../shared/notebook.js';
import { activeProjectPredicate } from '../projects.js';

export class NotebookError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 413 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}
export interface NotebookKernel {
  project: string;
  language: NotebookLanguage;
  generation: string;
  token: string;
  inputsHash: string;
  state: 'idle' | 'executing';
}
interface CellRow {
  id: string;
  language: NotebookLanguage;
  code: string;
  version: number;
  output: string;
  executed_by: string | null;
  state_lost: boolean;
}
const publicCell = (row: CellRow): NotebookCell => ({
  id: row.id,
  language: row.language,
  code: row.code,
  version: row.version,
  output: row.output,
  executedBy: row.executed_by,
  stateLost: row.state_lost,
});
export const notebookUnavailable = () =>
  new NotebookError(503, 'Notebook isolation is unavailable.');

/** @id CODE-NB-002 @implements REQ-NB-002 REQ-NB-003 */
export class NotebookRepository {
  constructor(public readonly pool: Pool) {}
  async authorize(owner: Principal, project: string, client: Pool | PoolClient = this.pool) {
    const result = await client.query(
      `SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()}`,
      [project, owner.tenantId, owner.objectId],
    );
    if (!result.rows.length) throw new NotebookError(404, 'Project not found.');
  }
  async locked<T>(project: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query("SET statement_timeout = '125s'");
      await client.query('SELECT pg_advisory_lock(1747289126,hashtext($1))', [project]);
      locked = true;
      return await action(client);
    } finally {
      if (locked)
        await client.query('SELECT pg_advisory_unlock(1747289126,hashtext($1))', [project]);
      await client.query('RESET statement_timeout');
      client.release();
    }
  }
  async list(owner: Principal, project: string) {
    await this.authorize(owner, project);
    const { rows } = await this.pool.query<CellRow>(
      'SELECT * FROM notebook_cells WHERE project_id=$1 AND tenant_id=$2 AND owner_oid=$3 ORDER BY created_at,id',
      [project, owner.tenantId, owner.objectId],
    );
    return { cells: rows.map(publicCell) };
  }
  async create(owner: Principal, project: string, language: NotebookLanguage, code: string) {
    return this.locked(project, async (client) => {
      await this.authorize(owner, project, client);
      const count = await client.query(
        'SELECT count(*)::int AS count FROM notebook_cells WHERE project_id=$1',
        [project],
      );
      if (count.rows[0].count >= 128) throw new NotebookError(429, 'Notebook cell limit reached.');
      const { rows } = await client.query<CellRow>(
        'INSERT INTO notebook_cells(id,tenant_id,owner_oid,project_id,language,code) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [randomUUID(), owner.tenantId, owner.objectId, project, language, code],
      );
      return publicCell(rows[0]!);
    });
  }
  async get(client: PoolClient, owner: Principal, project: string, id: string) {
    await this.authorize(owner, project, client);
    const { rows } = await client.query<CellRow>(
      'SELECT * FROM notebook_cells WHERE id=$1 AND project_id=$2 AND tenant_id=$3 AND owner_oid=$4',
      [id, project, owner.tenantId, owner.objectId],
    );
    if (!rows[0]) throw new NotebookError(404, 'Cell not found.');
    return publicCell(rows[0]);
  }
  async save(owner: Principal, project: string, id: string, version: number, code: string) {
    return this.locked(project, async (client) => {
      const current = await this.get(client, owner, project, id);
      if (current.version !== version || version >= 2147483647)
        throw new NotebookError(409, 'Cell changed. Reload before saving.');
      const { rows } = await client.query<CellRow>(
        'UPDATE notebook_cells SET code=$2,version=version+1 WHERE id=$1 AND version=$3 RETURNING *',
        [id, code, version],
      );
      if (!rows[0]) throw new NotebookError(409, 'Cell changed.');
      return publicCell(rows[0]);
    });
  }
  async kernel(
    client: PoolClient,
    project: string,
    language: NotebookLanguage,
  ): Promise<NotebookKernel | undefined> {
    const { rows } = await client.query(
      'SELECT * FROM notebook_kernels WHERE project_id=$1 AND language=$2',
      [project, language],
    );
    const row = rows[0];
    return row
      ? {
          project,
          language,
          generation: row.generation,
          token: row.token,
          inputsHash: row.inputs_hash,
          state: row.state,
        }
      : undefined;
  }
  /** @id CODE-NB-005 @implements REQ-NB-005 */
  async reserve(
    client: PoolClient,
    owner: Principal,
    project: string,
    language: NotebookLanguage,
    inputsHash: string,
  ) {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(1747289125)');
      await this.authorize(owner, project, client);
      const count = await client.query('SELECT count(*)::int AS count FROM notebook_kernels');
      if (count.rows[0].count >= 8)
        throw new NotebookError(429, 'Eight kernels are already admitted.');
      const kernel: NotebookKernel = {
        project,
        language,
        generation: randomUUID(),
        token: randomBytes(32).toString('hex'),
        inputsHash,
        state: 'idle',
      };
      await client.query(
        "INSERT INTO notebook_kernels(project_id,tenant_id,owner_oid,language,generation,token,inputs_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,'idle')",
        [
          project,
          owner.tenantId,
          owner.objectId,
          language,
          kernel.generation,
          kernel.token,
          inputsHash,
        ],
      );
      await client.query('COMMIT');
      return kernel;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  async removed(client: PoolClient, kernel: NotebookKernel) {
    await client.query('DELETE FROM notebook_kernels WHERE generation=$1', [kernel.generation]);
    await client.query(
      'UPDATE notebook_cells SET state_lost=true WHERE project_id=$1 AND language=$2',
      [kernel.project, kernel.language],
    );
  }
  async result(client: PoolClient, owner: Principal, cell: NotebookCell, output: string) {
    const { rows } = await client.query<CellRow>(
      'UPDATE notebook_cells SET output=$2,executed_by=$3 WHERE id=$1 AND version=$4 RETURNING *',
      [cell.id, output, owner.objectId, cell.version],
    );
    if (!rows[0]) throw new NotebookError(409, 'Cell changed during execution.');
    return publicCell(rows[0]);
  }
}
