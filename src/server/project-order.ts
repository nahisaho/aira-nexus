import type { Pool, PoolClient } from 'pg';
import type { Principal } from '../shared/contracts.js';
import { projectOrderMoveSchema, projectOrderVersionSchema } from '../shared/project-order.js';
import type { ProjectOrderMove, ProjectOrderSnapshot } from '../shared/project-order.js';
import { activeProjectPredicate, ProjectError } from './projects.js';
export type { ProjectOrderMove, ProjectOrderSnapshot } from '../shared/project-order.js';

interface OrderRow {
  state: ProjectOrderSnapshot | null;
  members: { id: string; pinned: boolean }[];
}
const conflict = () =>
  new ProjectError(409, 'VERSION_CONFLICT', 'Project order changed. Reload before moving.');
const materialize = (visible: string[], saved: string[]) => {
  const ranked = new Set(saved);
  return [...visible.filter((id) => !ranked.has(id)), ...saved];
};
function visibleOrder(row: OrderRow): ProjectOrderSnapshot {
  const snapshot = {
    version: row.state?.version ?? 1,
    pinned: [] as string[],
    recent: [] as string[],
  };
  for (const group of ['pinned', 'recent'] as const) {
    const defaults = row.members
      .filter((member) => member.pinned === (group === 'pinned'))
      .map((member) => member.id);
    const members = new Set(defaults);
    snapshot[group] = materialize(defaults, row.state?.[group] ?? []).filter((id) =>
      members.has(id),
    );
  }
  return snapshot;
}

/** @id CODE-SID-011 @implements REQ-SID-006 REQ-SID-007 REQ-SID-009 */
export class ProjectOrderRepository {
  constructor(private readonly pool: Pool) {}

  async ready(): Promise<void> {
    await this.pool.query(
      'SELECT state.version,state.pinned,state.recent,pins.project_id,pins.pinned_at FROM project_order_states state CROSS JOIN project_pins pins LIMIT 0',
    );
  }

  private async read(client: Pool | PoolClient, owner: Principal): Promise<OrderRow> {
    const { rows } = await client.query<OrderRow>(
      `SELECT
         (SELECT jsonb_build_object('version',version,'pinned',pinned,'recent',recent)
          FROM project_order_states WHERE tenant_id=$1 AND owner_oid=$2) AS state,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'pinned',pins.project_id IS NOT NULL)
           ORDER BY CASE WHEN pins.project_id IS NOT NULL THEN pins.pinned_at ELSE p.updated_at END DESC,p.id ASC),'[]'::jsonb)
          FROM projects p LEFT JOIN project_pins pins ON pins.project_id=p.id
          WHERE p.tenant_id=$1 AND p.owner_oid=$2 AND ${activeProjectPredicate('p')}) AS members`,
      [owner.tenantId, owner.objectId],
    );
    return rows[0]!;
  }

  async get(owner: Principal): Promise<ProjectOrderSnapshot> {
    return visibleOrder(await this.read(this.pool, owner));
  }

  async move(
    owner: Principal,
    version: number,
    input: ProjectOrderMove,
  ): Promise<ProjectOrderSnapshot> {
    const parsed = projectOrderMoveSchema.safeParse(input);
    if (!parsed.success || !projectOrderVersionSchema.safeParse(version).success)
      throw new ProjectError(400, 'INVALID_INPUT', 'Invalid project order move.');
    const move = parsed.data;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        'INSERT INTO project_order_states(tenant_id,owner_oid) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [owner.tenantId, owner.objectId],
      );
      const { rows } = await client.query<{ version: number }>(
        'SELECT version FROM project_order_states WHERE tenant_id=$1 AND owner_oid=$2 FOR UPDATE',
        [owner.tenantId, owner.objectId],
      );
      if (rows[0]?.version !== version || version === 2147483647) throw conflict();
      const involved = [move.projectId, ...(move.beforeId ? [move.beforeId] : [])];
      const locked = await client.query(
        `SELECT id FROM projects WHERE tenant_id=$1 AND owner_oid=$2 AND id=ANY($3::uuid[])
         AND ${activeProjectPredicate()} ORDER BY id ASC FOR UPDATE`,
        [owner.tenantId, owner.objectId, involved],
      );
      if (locked.rowCount !== involved.length)
        throw new ProjectError(404, 'NOT_FOUND', 'Project not found.');
      // Re-read membership in a later READ COMMITTED statement, after any pin writer releases its lock.
      const row = await this.read(client, owner);
      const current = visibleOrder(row);
      if (!involved.every((id) => current[move.group].includes(id))) throw conflict();
      const full = materialize(
        row.members
          .filter((member) => member.pinned === (move.group === 'pinned'))
          .map((member) => member.id),
        row.state?.[move.group] ?? [],
      ).filter((id) => id !== move.projectId);
      const index = move.beforeId === null ? full.length : full.indexOf(move.beforeId);
      if (index < 0) throw conflict();
      full.splice(index, 0, move.projectId);
      // The column is selected exclusively from the validated group enum.
      await client.query(
        `UPDATE project_order_states SET ${move.group}=$3::uuid[],version=version+1 WHERE tenant_id=$1 AND owner_oid=$2`,
        [owner.tenantId, owner.objectId, full],
      );
      const acknowledged = visibleOrder(await this.read(client, owner));
      await client.query('COMMIT');
      return acknowledged;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
