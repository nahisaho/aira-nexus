import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from '../../shared/contracts.js';
import { jobTransition } from '../../shared/jobs.js';
import type { Job, JobClaim, JobEvent, JobPage, JobState, JsonValue } from '../../shared/jobs.js';
import { JobError } from './errors.js';
import { canonicalJobInput } from './service.js';
import { activeProjectPredicate } from '../projects.js';
import { syncChatJobTransition } from '../chat/job-transitions.js';
import type { ChatFailureCode } from '../../shared/chat.js';

interface JobRow {
  id: string;
  tenant_id: string;
  owner_oid: string;
  project_id: string;
  type: string;
  input: JsonValue;
  state: JobState;
  fence: string | null;
  lease_until: Date | null;
  cancel_deadline: Date | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  cancel_requested_at: Date | null;
  failure_code: string | null;
}
const publicJob = (row: JobRow): Job => ({
  id: row.id,
  projectId: row.project_id,
  type: row.type,
  state: row.state,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  finishedAt: row.finished_at?.toISOString() ?? null,
  cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
  failureCode: row.failure_code,
});
const missing = () => new JobError(404, 'NOT_FOUND', 'Job or project not found.');
const cursorSchema = z.tuple([z.iso.datetime({ precision: 3 }), z.uuid()]);
function chatFailureCode(value: string | null): ChatFailureCode | null {
  switch (value) {
    case 'handler_failed':
    case 'interrupted':
    case 'cancellation_unconfirmed':
    case 'invalid_input':
      return value;
    default:
      return null;
  }
}
function parseCursor(cursor: string | undefined): [string, string] | null {
  if (cursor === undefined) return null;
  const bad = () => new JobError(400, 'INVALID_CURSOR', 'Invalid job cursor.');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw bad();
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) throw bad();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw bad();
    throw error;
  }
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success || new Date(parsed.data[0]).toISOString() !== parsed.data[0]) throw bad();
  return [parsed.data[0], parsed.data[1].toLowerCase()];
}

/** @id CODE-SVC-013 @implements REQ-SVC-003 REQ-SVC-010 REQ-SVC-011 REQ-SVC-012 REQ-SVC-013 */
export class JobRepository {
  constructor(private readonly pool: Pool) {}
  async authorize(
    owner: Principal,
    project: string,
    client: Pick<PoolClient, 'query'> = this.pool,
  ): Promise<void> {
    if (!z.uuid().safeParse(project).success) throw missing();
    const found = await client.query(
      `SELECT 1 FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()}`,
      [project, owner.tenantId, owner.objectId],
    );
    if (!found.rowCount) throw missing();
  }
  async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(1747289124)');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query(error instanceof JobError ? 'COMMIT' : 'ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async reconcile(client: PoolClient): Promise<void> {
    const expired = await client.query<JobRow>(
      `UPDATE durable_jobs SET state=$1,
      failure_code=CASE WHEN state='cancel_requested' THEN 'cancellation_unconfirmed' ELSE 'interrupted' END,
      fence=NULL,lease_until=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE state IN ('running','cancel_requested') AND
      (lease_until<=clock_timestamp() OR cancel_deadline<=clock_timestamp()
       OR (type='chat.generate' AND started_at+interval '300 seconds'<=clock_timestamp()))
      RETURNING *`,
      [jobTransition('running', 'expiry')],
    );
    for (const row of expired.rows) {
      if (row.type === 'chat.generate')
        await syncChatJobTransition(client, row, row.state, chatFailureCode(row.failure_code));
    }
  }
  private async owned<T>(
    owner: Principal,
    project: string,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (client) => {
      await this.authorize(owner, project, client);
      await this.reconcile(client);
      return action(client);
    });
  }
  private async find(
    client: PoolClient,
    owner: Principal,
    project: string,
    id: string,
  ): Promise<JobRow> {
    if (!z.uuid().safeParse(id).success) throw missing();
    const row = (
      await client.query<JobRow>(
        'SELECT * FROM durable_jobs WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4',
        [id, owner.tenantId, owner.objectId, project],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }
  async enqueue(
    owner: Principal,
    project: string,
    key: string,
    type: string,
    input: JsonValue,
  ): Promise<{ job: Job; created: boolean }> {
    return this.owned(owner, project, (client) =>
      this.enqueueWithin(client, owner, project, key, type, input),
    );
  }
  async enqueueWithin(
    client: PoolClient,
    owner: Principal,
    project: string,
    key: string,
    type: string,
    input: JsonValue,
  ): Promise<{ job: Job; created: boolean }> {
    const canonical = canonicalJobInput(input);
    const existing = (
      await client.query<JobRow>(
        'SELECT * FROM durable_jobs WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3 AND idempotency_key=$4',
        [owner.tenantId, owner.objectId, project, key],
      )
    ).rows[0];
    if (existing) {
      if (existing.type !== type || canonicalJobInput(existing.input) !== canonical)
        throw new JobError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key already has different input.',
        );
      return { job: publicJob(existing), created: false };
    }
    const counts = (
      await client.query<{ global: number; owner: number }>(
        `SELECT count(*)::int AS global,
        count(*) FILTER(WHERE tenant_id=$1 AND owner_oid=$2)::int AS owner FROM durable_jobs
        WHERE state IN ('queued','running','cancel_requested')`,
        [owner.tenantId, owner.objectId],
      )
    ).rows[0];
    if (!counts) throw new Error('Job admission count unavailable.');
    if (counts.global >= 200 || counts.owner >= 20)
      throw new JobError(429, 'JOB_CAPACITY', 'Job queue capacity exceeded.');
    const row = (
      await client.query<JobRow>(
        `INSERT INTO durable_jobs(id,tenant_id,owner_oid,project_id,idempotency_key,type,input)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
        [randomUUID(), owner.tenantId, owner.objectId, project, key, type, canonical],
      )
    ).rows[0];
    if (!row) throw new Error('Job insert returned no row.');
    return { job: publicJob(row), created: true };
  }
  async list(owner: Principal, project: string, cursor?: string): Promise<JobPage> {
    return this.owned(owner, project, async (client) => {
      const position = parseCursor(cursor);
      const rows = (
        await client.query<JobRow>(
          `SELECT * FROM durable_jobs
        WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3
        AND ($4::timestamptz IS NULL OR created_at<$4 OR (created_at=$4 AND id>$5::uuid))
        ORDER BY created_at DESC,id ASC LIMIT 101`,
          [owner.tenantId, owner.objectId, project, position?.[0] ?? null, position?.[1] ?? null],
        )
      ).rows;
      const items = rows.slice(0, 100).map(publicJob);
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
  async get(owner: Principal, project: string, id: string): Promise<Job> {
    return this.owned(owner, project, async (client) =>
      publicJob(await this.find(client, owner, project, id)),
    );
  }
  async cancel(owner: Principal, project: string, id: string): Promise<Job> {
    return this.owned(owner, project, (client) => this.cancelWithin(client, owner, project, id));
  }
  async cancelWithin(
    client: PoolClient,
    owner: Principal,
    project: string,
    id: string,
  ): Promise<Job> {
    const row = await this.find(client, owner, project, id);
    const next = jobTransition(row.state, 'cancel');
    if (next === row.state) return publicJob(row);
    if (!next) throw new Error('Invalid job cancellation state.');
    const updated = (
      await client.query<JobRow>(
        `UPDATE durable_jobs SET state=$2,
        cancel_requested_at=clock_timestamp(),updated_at=clock_timestamp(),
        cancel_deadline=CASE WHEN $2='cancel_requested' THEN clock_timestamp()+interval '30 seconds' ELSE NULL END,
        finished_at=CASE WHEN $2='cancelled' THEN clock_timestamp() ELSE NULL END
        WHERE id=$1 RETURNING *`,
        [id, next],
      )
    ).rows[0];
    if (!updated) throw new Error('Job cancel returned no row.');
    if (row.type === 'chat.generate')
      await syncChatJobTransition(
        client,
        row,
        updated.state,
        chatFailureCode(updated.failure_code),
      );
    return publicJob(updated);
  }
  async claim(types: readonly string[]): Promise<JobClaim | null> {
    return this.transaction(async (client) => {
      await this.reconcile(client);
      const row = (
        await client.query<JobRow>(
          `SELECT j.* FROM durable_jobs j WHERE j.state='queued' AND j.type=ANY($1::text[])
        AND (SELECT count(*) FROM durable_jobs a WHERE a.state IN ('running','cancel_requested'))<2
        AND NOT EXISTS(SELECT 1 FROM durable_jobs a WHERE a.tenant_id=j.tenant_id AND a.owner_oid=j.owner_oid AND a.state IN ('running','cancel_requested'))
        AND NOT EXISTS(SELECT 1 FROM durable_jobs a WHERE a.project_id=j.project_id AND a.state IN ('running','cancel_requested'))
        ORDER BY j.created_at ASC,j.id ASC LIMIT 1 FOR UPDATE`,
          [types],
        )
      ).rows[0];
      if (!row) return null;
      const fence = randomUUID();
      const updated = (
        await client.query<JobRow>(
          `UPDATE durable_jobs SET state=$2,fence=$3,
        lease_until=clock_timestamp()+interval '30 seconds',started_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`,
          [row.id, jobTransition(row.state, 'claim'), fence],
        )
      ).rows[0];
      if (!updated) throw new Error('Job claim returned no row.');
      if (row.type === 'chat.generate')
        await syncChatJobTransition(client, row, updated.state, null);
      return {
        job: publicJob(updated),
        owner: { tenantId: row.tenant_id, objectId: row.owner_oid },
        input: row.input,
        fence,
      };
    });
  }
  private claimParameters(claim: JobClaim): string[] {
    return [
      claim.job.id,
      claim.owner.tenantId,
      claim.owner.objectId,
      claim.job.projectId,
      claim.fence,
    ];
  }
  async heartbeat(claim: JobClaim): Promise<JobState | null> {
    return this.transaction(async (client) => {
      await this.reconcile(client);
      const row = (
        await client.query<{ state: JobState }>(
          `UPDATE durable_jobs SET
        lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4 AND fence=$5
        AND state IN ('running','cancel_requested') AND lease_until>clock_timestamp()
        AND (cancel_deadline IS NULL OR cancel_deadline>clock_timestamp())
        AND (type<>'chat.generate' OR started_at+interval '300 seconds'>clock_timestamp())
        RETURNING state`,
          this.claimParameters(claim),
        )
      ).rows[0];
      return row?.state ?? null;
    });
  }
  async finish(
    claim: JobClaim,
    event: Extract<JobEvent, 'success' | 'error' | 'stop_ack'>,
    code: 'handler_failed' | 'interrupted' | 'invalid_input' = 'handler_failed',
  ): Promise<Job | null> {
    return this.transaction(async (client) => {
      await this.reconcile(client);
      return this.finishWithin(client, claim, event, code);
    });
  }
  async finishWithin(
    client: PoolClient,
    claim: JobClaim,
    event: Extract<JobEvent, 'success' | 'error' | 'stop_ack'>,
    code: 'handler_failed' | 'interrupted' | 'invalid_input' = 'handler_failed',
  ): Promise<Job | null> {
    const row = (
      await client.query<JobRow>(
        `SELECT * FROM durable_jobs
        WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4 AND fence=$5`,
        this.claimParameters(claim),
      )
    ).rows[0];
    if (!row) return null;
    if (row.type === 'chat.generate' && row.state === 'cancel_requested' && event !== 'stop_ack')
      return null;
    const next = jobTransition(row.state, event);
    if (!next) return null;
    const updated = (
      await client.query<JobRow>(
        `UPDATE durable_jobs SET state=$6,
        failure_code=CASE WHEN $6='failed' THEN $7 ELSE NULL END,
        fence=NULL,lease_until=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4 AND fence=$5
        AND state IN ('running','cancel_requested') AND lease_until>clock_timestamp()
        AND (cancel_deadline IS NULL OR cancel_deadline>clock_timestamp())
        AND (type<>'chat.generate' OR started_at+interval '300 seconds'>clock_timestamp())
        RETURNING *`,
        [...this.claimParameters(claim), next, code],
      )
    ).rows[0];
    if (updated && row.type === 'chat.generate')
      await syncChatJobTransition(
        client,
        row,
        updated.state,
        chatFailureCode(updated.failure_code),
      );
    return updated ? publicJob(updated) : null;
  }
}
