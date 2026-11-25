import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from '../../shared/contracts.js';
import { PROJECT_FILE_BYTES } from '../../shared/files.js';
import type { ProjectFile } from '../../shared/files.js';
import type { Job, JobClaim, JobState } from '../../shared/jobs.js';
import type {
  ConversionArtifact,
  ConversionPage,
  ConversionRequest,
} from '../../shared/conversions.js';
import protocol from '../../shared/conversion-protocol.json' with { type: 'json' };
import { FileRepository } from '../files/repository.js';
import { FileError } from '../files/service.js';
import { JobRepository } from '../jobs/repository.js';
import { JobError } from '../jobs/errors.js';
import { activeProjectPredicate } from '../projects.js';

export interface ConversionPublication {
  markdown: { id: string; sha256: string; etag: string };
  json: { id: string; sha256: string; etag: string };
}
interface FileRow {
  id: string;
  name: string;
  size_bytes: string;
  kind: ProjectFile['kind'];
  sha256: string;
  etag: string;
  created_at: Date;
  state: string;
  trashed_at: Date | null;
  live: boolean;
}
interface RequestRow {
  id: string;
  tenant_id: string;
  owner_oid: string;
  project_id: string;
  source_file_id: string;
  source_name: string;
  source_size: string;
  source_sha256: string;
  source_etag: string;
  state: 'waiting' | 'linked-to-job' | 'failed-before-admission' | 'cancelled-before-admission';
  job_id: string | null;
  reason: string | null;
  markdown_id: string | null;
  json_id: string | null;
  created_at: Date;
  updated_at: Date;
}
const missing = () => new FileError(404, 'NOT_FOUND', 'Conversion, source or project not found.');
const metadata = (row: FileRow): ProjectFile => ({
  id: row.id,
  name: row.name,
  size: Number(row.size_bytes),
  kind: row.kind,
  sha256: row.sha256,
  createdAt: row.created_at.toISOString(),
});
const eligible = (name: string, size: number) =>
  protocol.formats.includes(name.split('.').at(-1)?.toLowerCase() ?? '') &&
  size <= protocol.limits.inputBytes;
const cursorSchema = z.tuple([z.iso.datetime({ precision: 3 }), z.uuid()]);
function cursorPosition(cursor?: string): [string, string] | null {
  if (cursor === undefined) return null;
  const invalid = () => new FileError(400, 'INVALID_CURSOR', 'Invalid conversion cursor.');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw invalid();
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw invalid();
    throw error;
  }
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success || new Date(parsed.data[0]).toISOString() !== parsed.data[0]) throw invalid();
  return parsed.data;
}
class PublicationFenced extends Error {}

/** @id CODE-DCV-002 @implements REQ-DCV-001 REQ-DCV-002 REQ-DCV-003 REQ-DCV-004 REQ-DCV-005 REQ-DCV-006 */
export class ConversionRepository {
  private readonly jobs: JobRepository;
  constructor(private readonly pool: Pool) {
    this.jobs = new JobRepository(pool);
  }

  async ready(): Promise<void> {
    await this.pool.query(
      `SELECT id,source_sha256,active,markdown_id,json_id FROM document_conversion_requests LIMIT 0`,
    );
  }
  async authorizeSource(owner: Principal, project: string, id: string): Promise<void> {
    await this.owned(owner, project, async (client) => {
      if (!(await this.source(client, project, id))) throw missing();
    });
  }
  async claimIsCurrent(jobId: string, fence: string): Promise<boolean> {
    return !!(
      await this.pool.query(
        `SELECT 1 FROM durable_jobs WHERE id=$1 AND fence=$2 AND state IN ('running','cancel_requested')
       AND lease_until>clock_timestamp() AND (cancel_deadline IS NULL OR cancel_deadline>clock_timestamp())`,
        [jobId, fence],
      )
    ).rowCount;
  }
  async sourceForClaim(claim: JobClaim) {
    return this.owned(claim.owner, claim.job.projectId, async (client) => {
      if ((await this.current(client, claim))?.state !== 'running')
        throw new FileError(409, 'CONVERSION_FENCED', 'Conversion claim is unavailable.');
      const row = await this.linked(client, claim);
      const source = await this.source(client, row.project_id, row.source_file_id);
      if (!source || !this.unchanged(source, row))
        throw new FileError(409, 'CONVERSION_SOURCE_CHANGED', 'Conversion source is unavailable.');
      return { ...metadata(source), etag: source.etag, key: `${row.project_id}/${source.id}` };
    });
  }
  private async lockProject(client: PoolClient, owner: Principal, project: string) {
    if (!z.uuid().safeParse(project).success) throw missing();
    const found = await client.query(
      `SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()} FOR UPDATE`,
      [project, owner.tenantId, owner.objectId],
    );
    if (!found.rowCount) throw missing();
  }
  private async clearGuards(client: PoolClient) {
    await client.query(`UPDATE document_conversion_requests r SET active=false
      FROM durable_jobs j WHERE r.job_id=j.id AND r.tenant_id=j.tenant_id AND r.owner_oid=j.owner_oid
      AND r.project_id=j.project_id AND r.active AND j.state IN ('succeeded','failed','cancelled')`);
  }
  private async owned<T>(
    owner: Principal,
    project: string,
    run: (client: PoolClient) => Promise<T>,
  ) {
    return this.jobs.transaction(async (client) => {
      await this.jobs.reconcile(client);
      await this.clearGuards(client);
      await this.lockProject(client, owner, project);
      return run(client);
    });
  }
  private async find(client: PoolClient, owner: Principal, project: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw missing();
    const row = (
      await client.query<RequestRow>(
        `SELECT * FROM document_conversion_requests WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4`,
        [id, owner.tenantId, owner.objectId, project],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }
  private async source(client: PoolClient, project: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw missing();
    return (
      await client.query<FileRow>(
        `SELECT *,expires_at>clock_timestamp() AS live FROM project_files
       WHERE project_id=$1 AND id=$2 AND state='ready' AND trashed_at IS NULL`,
        [project, id],
      )
    ).rows[0];
  }
  private unchanged(source: FileRow, request: RequestRow) {
    return (
      Number(source.size_bytes) === Number(request.source_size) &&
      source.sha256 === request.source_sha256 &&
      source.etag === request.source_etag
    );
  }
  private async insert(
    client: PoolClient,
    owner: Principal,
    project: string,
    source: FileRow,
    key: string,
    origin: 'automatic' | 'manual',
  ) {
    const row = (
      await client.query<RequestRow>(
        `INSERT INTO document_conversion_requests(id,tenant_id,owner_oid,project_id,source_file_id,
       source_name,source_size,source_sha256,source_etag,idempotency_key,origin)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          randomUUID(),
          owner.tenantId,
          owner.objectId,
          project,
          source.id,
          source.name,
          source.size_bytes,
          source.sha256,
          source.etag,
          key,
          origin,
        ],
      )
    ).rows[0];
    if (!row) throw new Error('Conversion insert returned no row.');
    return row;
  }
  async finalizeUpload(
    owner: Principal,
    project: string,
    id: string,
    sha: string,
    etag: string,
  ): Promise<ProjectFile> {
    if (!z.uuid().safeParse(id).success) throw missing();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockProject(client, owner, project);
      const source = (
        await client.query<FileRow>(
          `UPDATE project_files SET state='ready',sha256=$3,etag=$4 WHERE project_id=$1 AND id=$2
         AND state='uploading' AND expires_at>clock_timestamp() RETURNING *`,
          [project, id, sha, etag],
        )
      ).rows[0];
      if (!source)
        throw new FileError(409, 'UPLOAD_EXPIRED', 'Upload expired or already finalized.');
      if (eligible(source.name, Number(source.size_bytes)))
        await this.insert(client, owner, project, source, `auto:${id}`, 'automatic');
      await client.query('COMMIT');
      return metadata(source);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async request(
    owner: Principal,
    project: string,
    sourceId: string,
    key: string | undefined,
  ): Promise<{ request: ConversionRequest; created: boolean }> {
    return this.owned(owner, project, async (client) => {
      const source = await this.source(client, project, sourceId);
      if (!source) throw missing();
      if (!protocol.formats.includes(source.name.split('.').at(-1)?.toLowerCase() ?? ''))
        throw new FileError(415, 'UNSUPPORTED_CONVERSION', 'This file type cannot be converted.');
      if (Number(source.size_bytes) > protocol.limits.inputBytes)
        throw new FileError(
          413,
          'CONVERSION_INPUT_TOO_LARGE',
          'File exceeds the conversion limit.',
        );
      if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
        throw new FileError(400, 'INVALID_CONVERSION', 'A valid Idempotency-Key is required.');
      const existing = (
        await client.query<RequestRow>(
          `SELECT * FROM document_conversion_requests WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3 AND idempotency_key=$4`,
          [owner.tenantId, owner.objectId, project, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.source_file_id !== sourceId.toLowerCase() || !this.unchanged(source, existing))
          throw new FileError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key already has different input.',
          );
        return { request: await this.present(client, existing), created: false };
      }
      const active = await client.query(
        `SELECT 1 FROM document_conversion_requests WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3 AND source_file_id=$4 AND active`,
        [owner.tenantId, owner.objectId, project, sourceId],
      );
      if (active.rowCount)
        throw new FileError(409, 'CONVERSION_ACTIVE', 'A conversion is already active.');
      return {
        request: await this.present(
          client,
          await this.insert(client, owner, project, source, key, 'manual'),
        ),
        created: true,
      };
    });
  }
  private async artifact(
    client: PoolClient,
    project: string,
    id: string,
  ): Promise<ConversionArtifact> {
    const row = (
      await client.query<FileRow>(
        `SELECT * FROM project_files WHERE project_id=$1 AND id=$2 AND state='ready'`,
        [project, id],
      )
    ).rows[0];
    return {
      id,
      availability: !row ? 'missing' : row.trashed_at ? 'trashed' : 'available',
      file: row && !row.trashed_at ? metadata(row) : null,
    };
  }
  private async present(client: PoolClient, row: RequestRow): Promise<ConversionRequest> {
    const job = row.job_id
      ? (
          await client.query<{ state: JobState; failure_code: string | null; updated_at: Date }>(
            `SELECT state,failure_code,updated_at FROM durable_jobs WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4`,
            [row.job_id, row.tenant_id, row.owner_oid, row.project_id],
          )
        ).rows[0]
      : undefined;
    if (row.job_id && !job) throw new Error('Linked conversion job is unavailable.');
    const state =
      job?.state ??
      (row.state === 'waiting'
        ? 'waiting'
        : row.state === 'cancelled-before-admission'
          ? 'cancelled'
          : 'failed');
    let artifacts: ConversionRequest['artifacts'] = null;
    if (state === 'succeeded') {
      if (!row.markdown_id || !row.json_id)
        throw new Error('Successful conversion artifacts are unavailable.');
      artifacts = {
        markdown: await this.artifact(client, row.project_id, row.markdown_id),
        json: await this.artifact(client, row.project_id, row.json_id),
      };
    }
    return {
      id: row.id,
      projectId: row.project_id,
      sourceId: row.source_file_id,
      sourceName: row.source_name,
      jobId: row.job_id,
      state,
      reason: state === 'failed' ? (row.reason ?? job?.failure_code ?? 'handler_failed') : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: new Date(
        Math.max(row.updated_at.getTime(), job?.updated_at.getTime() ?? 0),
      ).toISOString(),
      artifacts,
    };
  }
  async list(owner: Principal, project: string, cursor?: string): Promise<ConversionPage> {
    return this.owned(owner, project, async (client) => {
      const position = cursorPosition(cursor);
      const rows = (
        await client.query<RequestRow>(
          `SELECT * FROM document_conversion_requests WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3
         AND ($4::timestamptz IS NULL OR created_at<$4 OR (created_at=$4 AND id>$5::uuid))
         ORDER BY created_at DESC,id ASC LIMIT 101`,
          [owner.tenantId, owner.objectId, project, position?.[0] ?? null, position?.[1] ?? null],
        )
      ).rows;
      const items = [];
      for (const row of rows.slice(0, 100)) items.push(await this.present(client, row));
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > 100 && last
            ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url')
            : null,
      };
    });
  }
  async get(owner: Principal, project: string, id: string): Promise<ConversionRequest> {
    return this.owned(owner, project, async (client) =>
      this.present(client, await this.find(client, owner, project, id)),
    );
  }
  async cancel(owner: Principal, project: string, id: string): Promise<ConversionRequest> {
    return this.owned(owner, project, async (client) => {
      const row = await this.find(client, owner, project, id);
      if (row.state === 'waiting') {
        await client.query(
          `UPDATE document_conversion_requests SET state='cancelled-before-admission',active=false,updated_at=clock_timestamp() WHERE id=$1`,
          [id],
        );
      } else if (row.job_id) {
        const job = await this.jobs.cancelWithin(client, owner, project, row.job_id);
        if (['succeeded', 'failed', 'cancelled'].includes(job.state))
          await this.clearGuards(client);
      }
      return this.present(client, await this.find(client, owner, project, id));
    });
  }
  async dispatch(): Promise<number> {
    return this.jobs.transaction(async (client) => {
      await this.jobs.reconcile(client);
      await this.clearGuards(client);
      const heads = (
        await client.query<RequestRow>(
          `SELECT h.* FROM (SELECT DISTINCT ON (tenant_id,owner_oid) r.*
         FROM document_conversion_requests r WHERE state='waiting'
         AND (SELECT count(*) FROM durable_jobs j WHERE j.tenant_id=r.tenant_id AND j.owner_oid=r.owner_oid
          AND j.state IN ('queued','running','cancel_requested'))<20
         ORDER BY tenant_id,owner_oid,created_at,id) h ORDER BY created_at,id LIMIT 100`,
        )
      ).rows;
      let admitted = 0;
      for (const row of heads) {
        const owner = { tenantId: row.tenant_id, objectId: row.owner_oid };
        const project = await client.query(
          `SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()} FOR UPDATE`,
          [row.project_id, row.tenant_id, row.owner_oid],
        );
        const source = project.rowCount
          ? await this.source(client, row.project_id, row.source_file_id)
          : undefined;
        if (!source || !this.unchanged(source, row)) {
          await client.query(
            `UPDATE document_conversion_requests SET state='failed-before-admission',active=false,reason=$2,updated_at=clock_timestamp() WHERE id=$1`,
            [row.id, source ? 'source_changed' : 'source_unavailable'],
          );
          continue;
        }
        try {
          const result = await this.jobs.enqueueWithin(
            client,
            owner,
            row.project_id,
            `conversion:${row.id}`,
            'document.convert',
            { conversionId: row.id },
          );
          await client.query(
            `UPDATE document_conversion_requests SET state='linked-to-job',job_id=$2,updated_at=clock_timestamp() WHERE id=$1`,
            [row.id, result.job.id],
          );
          admitted++;
        } catch (error) {
          if (!(error instanceof JobError) || error.code !== 'JOB_CAPACITY') throw error;
        }
      }
      return admitted;
    });
  }
  private async current(client: PoolClient, claim: JobClaim) {
    return (
      await client.query<{ state: JobState }>(
        `SELECT state FROM durable_jobs WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4 AND fence=$5
       AND state IN ('running','cancel_requested') AND lease_until>clock_timestamp()
       AND (cancel_deadline IS NULL OR cancel_deadline>clock_timestamp())`,
        [
          claim.job.id,
          claim.owner.tenantId,
          claim.owner.objectId,
          claim.job.projectId,
          claim.fence,
        ],
      )
    ).rows[0];
  }
  private async linked(client: PoolClient, claim: JobClaim) {
    const row = (
      await client.query<RequestRow>(
        `SELECT * FROM document_conversion_requests WHERE job_id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4`,
        [claim.job.id, claim.owner.tenantId, claim.owner.objectId, claim.job.projectId],
      )
    ).rows[0];
    if (!row) throw new FileError(409, 'CONVERSION_FENCED', 'Conversion claim is unavailable.');
    return row;
  }
  private async usage(client: PoolClient, project: string) {
    return Number(
      (
        await client.query<{ bytes: string }>(
          `SELECT COALESCE(sum(size_bytes),0)::text AS bytes FROM project_files WHERE project_id=$1
       AND (state='ready' OR (state='uploading' AND expires_at>clock_timestamp()))`,
          [project],
        )
      ).rows[0]?.bytes,
    );
  }
  async reserveOutputs(
    claim: JobClaim,
    sizes: { markdown: number; json: number },
  ): Promise<{ markdown: string; json: string }> {
    if (
      ![sizes.markdown, sizes.json].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= protocol.limits.outputBytes,
      )
    )
      throw new FileError(413, 'CONVERSION_OUTPUT_TOO_LARGE', 'Invalid conversion output size.');
    return this.owned(claim.owner, claim.job.projectId, async (client) => {
      if ((await this.current(client, claim))?.state !== 'running')
        throw new FileError(409, 'CONVERSION_FENCED', 'Conversion claim is unavailable.');
      const row = await this.linked(client, claim);
      const source = await this.source(client, row.project_id, row.source_file_id);
      if (!source || !this.unchanged(source, row))
        throw new FileError(409, 'CONVERSION_SOURCE_CHANGED', 'Conversion source is unavailable.');
      if (row.markdown_id || row.json_id)
        throw new FileError(
          409,
          'CONVERSION_RESERVED',
          'Conversion outputs were already reserved.',
        );
      const used = await this.usage(client, row.project_id);
      if (!Number.isFinite(used)) throw new Error('Conversion quota is unavailable.');
      if (used + sizes.markdown + sizes.json > PROJECT_FILE_BYTES)
        throw new FileError(409, 'FILE_QUOTA_EXCEEDED', 'Project file quota exceeded.');
      const pair = { markdown: randomUUID(), json: randomUUID() };
      for (const [kind, extension] of [
        ['markdown', 'md'],
        ['json', 'json'],
      ] as const) {
        const suffix = `.${row.id}.${extension}`;
        const stem = row.source_name.replace(/\.[^.]*$/, '') || 'document';
        const name =
          Array.from(stem)
            .slice(0, 255 - suffix.length)
            .join('')
            .trimEnd() + suffix;
        await client.query(
          `INSERT INTO project_files(id,project_id,name,size_bytes,kind) VALUES($1,$2,$3,$4,'text')`,
          [pair[kind], row.project_id, name, sizes[kind]],
        );
      }
      await client.query(
        `UPDATE document_conversion_requests SET markdown_id=$2,json_id=$3 WHERE id=$1`,
        [row.id, pair.markdown, pair.json],
      );
      return pair;
    });
  }
  async settle(
    claim: JobClaim,
    event: 'success' | 'error',
    result: { publication?: ConversionPublication; reason?: string },
  ): Promise<Job | null> {
    try {
      return await this.jobs.transaction(async (client) => {
        await this.jobs.reconcile(client);
        await this.clearGuards(client);
        const current = await this.current(client, claim);
        if (!current) return null;
        const row = await this.linked(client, claim);
        const project = await client.query(
          `SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()} FOR UPDATE`,
          [row.project_id, row.tenant_id, row.owner_oid],
        );
        let reason = result.reason ?? 'handler_failed';
        if (!protocol.failureCodes.includes(reason))
          throw new FileError(400, 'INVALID_CONVERSION', 'Invalid conversion result.');
        let publish = event === 'success' && current.state === 'running' && !!project.rowCount;
        if (event === 'success' && current.state === 'running') {
          const source = project.rowCount
            ? await this.source(client, row.project_id, row.source_file_id)
            : undefined;
          if (!source || !this.unchanged(source, row)) {
            publish = false;
            reason = source ? 'source_changed' : 'source_unavailable';
          }
          const pair = result.publication;
          const output = z.strictObject({
            id: z.uuid(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            etag: z.string().min(1).max(1024),
          });
          if (
            !pair ||
            !output.safeParse(pair.markdown).success ||
            !output.safeParse(pair.json).success ||
            pair.markdown.id !== row.markdown_id ||
            pair.json.id !== row.json_id
          ) {
            publish = false;
            reason = 'output_invalid';
          }
          const reservations = (
            await client.query<FileRow>(
              `SELECT *,expires_at>clock_timestamp() AS live FROM project_files WHERE project_id=$1 AND id=ANY($2::uuid[])`,
              [row.project_id, [row.markdown_id, row.json_id]],
            )
          ).rows;
          if (
            reservations.length !== 2 ||
            reservations.some((file) => file.state !== 'uploading' || !file.live)
          ) {
            publish = false;
            reason = 'output_invalid';
          }
          const used = await this.usage(client, row.project_id);
          if (!Number.isFinite(used)) throw new Error('Conversion quota is unavailable.');
          if (used > PROJECT_FILE_BYTES) {
            publish = false;
            reason = 'quota_exceeded';
          }
          if (publish && pair) {
            for (const file of [pair.markdown, pair.json]) {
              const saved = await client.query(
                `UPDATE project_files SET state='ready',sha256=$3,etag=$4
                WHERE project_id=$1 AND id=$2 AND state='uploading' AND expires_at>clock_timestamp() RETURNING id`,
                [row.project_id, file.id, file.sha256, file.etag],
              );
              if (!saved.rowCount) throw new PublicationFenced();
            }
          }
        }
        const job = await this.jobs.finishWithin(
          client,
          claim,
          publish ? 'success' : 'error',
          reason === 'interrupted' ? 'interrupted' : 'handler_failed',
        );
        if (!job) throw new PublicationFenced();
        await client.query(
          `UPDATE document_conversion_requests SET active=false,reason=$2,updated_at=clock_timestamp() WHERE id=$1`,
          [row.id, job.state === 'failed' ? reason : null],
        );
        return job;
      });
    } catch (error) {
      if (!(error instanceof PublicationFenced)) throw error;
      console.error(
        JSON.stringify({ event: 'conversion_publication_fenced', jobId: claim.job.id }),
      );
      return null;
    }
  }
}
export class ConversionFileRepository extends FileRepository {
  constructor(
    pool: Pool,
    private readonly conversions: ConversionRepository,
  ) {
    super(pool);
  }
  override finalize(owner: Principal, project: string, id: string, sha: string, etag: string) {
    return this.conversions.finalizeUpload(owner, project, id, sha, etag);
  }
}
