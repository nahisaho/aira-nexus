import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from '../../shared/contracts.js';
import type { FilePage, ProjectFile, UploadMetadata } from '../../shared/files.js';
import { PROJECT_FILE_BYTES } from '../../shared/files.js';
import { FileError, validateUpload } from './service.js';
import { activeProjectPredicate } from '../projects.js';
export interface StoredFile extends ProjectFile {
  key: string;
  etag: string;
}
interface FileRow {
  id: string;
  name: string;
  size_bytes: string;
  kind: ProjectFile['kind'];
  created_at: Date;
  sha256: string;
  etag: string;
}
const columns = 'f.id,f.name,f.size_bytes,f.kind,f.created_at,f.sha256,f.etag';
const metadata = (row: FileRow): ProjectFile => ({
  id: row.id,
  name: row.name,
  size: Number(row.size_bytes),
  kind: row.kind,
  sha256: row.sha256,
  createdAt: row.created_at.toISOString(),
});
const notFound = () => new FileError(404, 'NOT_FOUND', 'Project or file not found.');
const cursorSchema = z.strictObject({ at: z.iso.datetime(), id: z.uuid() });
function decodeCursor(cursor?: string): { at: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const invalid = () => new FileError(400, 'INVALID_CURSOR', 'Invalid file cursor.');
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const decoded = Buffer.from(cursor, 'base64url');
  if (decoded.toString('base64url') !== cursor) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = cursorSchema.safeParse(value);
  if (
    !parsed.success ||
    !Number.isFinite(Date.parse(parsed.data.at)) ||
    Number(parsed.data.at.slice(0, 4)) < 1
  )
    throw invalid();
  return parsed.data;
}
/** @id CODE-SVC-001 @implements REQ-SVC-001 REQ-SVC-005 REQ-SVC-006 */
export class FileRepository {
  constructor(private readonly pool: Pool) {}
  private async owned<T>(
    owner: Principal,
    projectId: string,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!z.uuid().safeParse(projectId).success) throw notFound();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()} FOR UPDATE`,
        [projectId, owner.tenantId, owner.objectId],
      );
      if (!found.rowCount) throw notFound();
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async usage(client: PoolClient, projectId: string) {
    const { rows } = await client.query<{ used: string; reserved: string }>(
      "SELECT COALESCE(SUM(size_bytes) FILTER(WHERE state='ready'),0)::text AS used,COALESCE(SUM(size_bytes) FILTER(WHERE state='uploading' AND expires_at>clock_timestamp()),0)::text AS reserved FROM project_files WHERE project_id=$1",
      [projectId],
    );
    if (!rows[0]) throw new Error('File quota query returned no result.');
    return { usedBytes: Number(rows[0].used), reservedBytes: Number(rows[0].reserved) };
  }
  async reserve(owner: Principal, projectId: string, input: UploadMetadata): Promise<string> {
    return this.owned(owner, projectId, async (client) => {
      const upload = validateUpload(input),
        usage = await this.usage(client, projectId);
      if (usage.usedBytes + usage.reservedBytes + upload.size > PROJECT_FILE_BYTES)
        throw new FileError(409, 'FILE_QUOTA_EXCEEDED', 'Project file quota exceeded.');
      const id = randomUUID();
      await client.query(
        'INSERT INTO project_files(id,project_id,name,size_bytes,kind) VALUES($1,$2,$3,$4,$5)',
        [id, projectId, upload.name, upload.size, upload.kind],
      );
      return id;
    });
  }
  async finalize(
    owner: Principal,
    projectId: string,
    id: string,
    sha: string,
    etag: string,
  ): Promise<ProjectFile> {
    return this.owned(owner, projectId, async (client) => {
      const { rows } = await client.query<FileRow>(
        `UPDATE project_files f SET state='ready',sha256=$3,etag=$4 WHERE f.project_id=$1 AND f.id=$2 AND f.state='uploading' AND f.expires_at>clock_timestamp() RETURNING ${columns}`,
        [projectId, id, sha, etag],
      );
      if (!rows[0])
        throw new FileError(409, 'UPLOAD_EXPIRED', 'Upload expired or already finalized.');
      return metadata(rows[0]);
    });
  }
  async fail(owner: Principal, projectId: string, id: string): Promise<void> {
    await this.owned(owner, projectId, async (client) => {
      await client.query(
        "UPDATE project_files SET state='failed' WHERE project_id=$1 AND id=$2 AND state='uploading'",
        [projectId, id],
      );
    });
  }
  /** @id CODE-FEX-001 @implements REQ-FEX-002 */
  async list(
    owner: Principal,
    projectId: string,
    cursor?: string,
    trashed = false,
  ): Promise<FilePage> {
    return this.owned(owner, projectId, async (client) => {
      const decoded = decodeCursor(cursor);
      const { rows } = await client.query<FileRow>(
        `SELECT ${columns} FROM project_files f WHERE project_id=$1 AND state='ready' AND (trashed_at IS NOT NULL)=$4 AND ($2::timestamptz IS NULL OR created_at<$2 OR (created_at=$2 AND id>$3::uuid)) ORDER BY created_at DESC,id ASC LIMIT 101`,
        [projectId, decoded?.at ?? null, decoded?.id ?? null, trashed],
      );
      const items = rows.slice(0, 100).map(metadata),
        last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > 100 && last
            ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString('base64url')
            : null,
        ...(await this.usage(client, projectId)),
        limitBytes: PROJECT_FILE_BYTES,
      };
    });
  }
  /** @id CODE-FEX-002 @implements REQ-FEX-002 */
  async setTrashed(
    owner: Principal,
    projectId: string,
    id: string,
    trashed: boolean,
  ): Promise<void> {
    if (!z.uuid().safeParse(id).success) throw notFound();
    await this.owned(owner, projectId, async (client) => {
      const result = await client.query(
        "UPDATE project_files SET trashed_at=CASE WHEN $3 THEN COALESCE(trashed_at,clock_timestamp()) ELSE NULL END WHERE project_id=$1 AND id=$2 AND state='ready' AND ($3 OR NOT purge_pending) RETURNING id",
        [projectId, id, trashed],
      );
      if (!result.rowCount) {
        const pending = await client.query(
          'SELECT id FROM project_files WHERE project_id=$1 AND id=$2 AND purge_pending',
          [projectId, id],
        );
        if (pending.rowCount)
          throw new FileError(
            409,
            'FILE_PURGE_PENDING',
            'Permanent deletion is pending. Empty trash again to finish.',
          );
        throw notFound();
      }
    });
  }
  /** @id CODE-FTP-001 @implements REQ-FTP-002 REQ-FTP-003 */
  async beginPurge(owner: Principal, projectId: string): Promise<void> {
    await this.owned(owner, projectId, async (client) => {
      await client.query(
        "UPDATE project_files SET purge_pending=true WHERE project_id=$1 AND state='ready' AND trashed_at IS NOT NULL AND NOT purge_pending",
        [projectId],
      );
    });
  }
  async purgeBatch(
    owner: Principal,
    projectId: string,
  ): Promise<{ id: string; key: string; etag: string }[]> {
    return this.owned(owner, projectId, async (client) => {
      const { rows } = await client.query<{ id: string; etag: string }>(
        'SELECT id,etag FROM project_files WHERE project_id=$1 AND purge_pending ORDER BY id LIMIT 100',
        [projectId],
      );
      return rows.map((row) => ({ ...row, key: `${projectId.toLowerCase()}/${row.id}` }));
    });
  }
  async finishPurge(owner: Principal, projectId: string, id: string): Promise<void> {
    await this.owned(owner, projectId, async (client) => {
      await client.query(
        "DELETE FROM project_files WHERE project_id=$1 AND id=$2 AND state='ready' AND purge_pending",
        [projectId, id],
      );
    });
  }
  async get(owner: Principal, projectId: string, id: string): Promise<StoredFile> {
    if (!z.uuid().safeParse(projectId).success || !z.uuid().safeParse(id).success) throw notFound();
    const { rows } = await this.pool.query<FileRow>(
      `SELECT ${columns} FROM project_files f JOIN projects p ON p.id=f.project_id WHERE p.id=$1 AND p.tenant_id=$2 AND p.owner_oid=$3 AND ${activeProjectPredicate('p')} AND f.id=$4 AND f.state='ready' AND f.trashed_at IS NULL`,
      [projectId, owner.tenantId, owner.objectId, id],
    );
    if (!rows[0]) throw notFound();
    return {
      ...metadata(rows[0]),
      key: `${projectId.toLowerCase()}/${id.toLowerCase()}`,
      etag: rows[0].etag,
    };
  }
}
