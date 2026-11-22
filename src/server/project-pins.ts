import type { Pool } from 'pg';
import type { Principal } from '../shared/contracts.js';
import { z } from 'zod';
import { activeProjectPredicate } from './projects.js';

/** @id CODE-SID-001 @implements REQ-SID-001 */
export class ProjectPinsRepository {
  constructor(private readonly pool: Pool) {}

  async list(owner: Principal): Promise<string[]> {
    const { rows } = await this.pool.query<{ project_id: string }>(
      `SELECT pins.project_id FROM project_pins pins
       JOIN projects project ON project.id=pins.project_id
       WHERE project.tenant_id=$1 AND project.owner_oid=$2 AND ${activeProjectPredicate('project')}
       ORDER BY pins.pinned_at DESC, project.id ASC`,
      [owner.tenantId, owner.objectId],
    );
    return rows.map((row) => row.project_id);
  }

  async set(owner: Principal, id: string, pinned: boolean): Promise<boolean> {
    if (!z.uuid().safeParse(id).success) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()} FOR UPDATE`,
        [id, owner.tenantId, owner.objectId],
      );
      if (!rows.length) {
        await client.query('COMMIT');
        return false;
      }
      if (pinned) {
        await client.query(
          'INSERT INTO project_pins(project_id) VALUES($1) ON CONFLICT(project_id) DO NOTHING',
          [id],
        );
      } else {
        await client.query('DELETE FROM project_pins WHERE project_id=$1', [id]);
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
