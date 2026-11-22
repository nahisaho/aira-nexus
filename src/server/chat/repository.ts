
import type { Pool, PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from '../../shared/contracts.js';
import type { JobClaim } from '../../shared/jobs.js';
import type {
  ChatAdmission,
  ChatConversation,
  ChatPreviewAdmission,
  ChatDelta,
  ChatEvent,
  ChatFailureCode,
  ChatPage,
  ChatRun,
  ChatRunEventPage,
  ChatRunState,
  ChatTurn,
} from '../../shared/chat.js';
import { activeProjectPredicate } from '../projects.js';
import { JobRepository } from '../jobs/repository.js';
import { ChatError, chatMissing } from './errors.js';
import { parseModelInventory } from './models.js';

interface ConversationRow {
  id: string;
  created_at: Date;
  updated_at: Date;
  history_revision: number;
  preview: string;
  latest_run_id: string | null;
  active_run_id: string | null;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  sequence: number;
  role: 'user' | 'assistant';
  text: string;
  created_at: Date;
}

interface RunRow {
  id: string;
  job_id?: string;
  preview_id?: string | null;
  conversation_id: string;
  state: ChatRunState;
  model_id: string;
  snapshot_hash?: string;
  answer: string;
  failure_code: ChatFailureCode | null;
  created_at: Date;
  updated_at: Date;
  last_sequence: number;
  assistant_turn_sequence: number;
}

interface EventRow {
  sequence: number;
  event_key: string;
  type: 'delta' | 'status';
  text: string;
  state: ChatRunState | null;
  reason: ChatFailureCode | null;
  created_at: Date;
}

const uuid = z.uuid();
const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const conversationCursorSchema = z.tuple([z.iso.datetime({ precision: 3 }), z.uuid()]);
const turnCursorSchema = z.number().int().min(0).max(2147483647);
const pageSize = 100;
const missing = chatMissing;

function parseConversationCursor(cursor: string | undefined): [string, string] | null {
  if (cursor === undefined) return null;
  const invalid = () => new ChatError(400, 'INVALID_CURSOR', 'Invalid chat cursor.');
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
  const parsed = conversationCursorSchema.safeParse(value);
  if (!parsed.success || new Date(parsed.data[0]).toISOString() !== parsed.data[0]) throw invalid();
  return [parsed.data[0], parsed.data[1].toLowerCase()];
}

function parseTurnCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const invalid = () => new ChatError(400, 'INVALID_CURSOR', 'Invalid chat cursor.');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(cursor)) throw invalid();
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw invalid();
    throw error;
  }
  const parsed = turnCursorSchema.safeParse(value);
  if (!parsed.success || String(parsed.data) !== JSON.stringify(value)) throw invalid();
  return parsed.data;
}

function conversationDto(row: ConversationRow): ChatConversation {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    historyRevision: row.history_revision,
    preview: row.preview,
    latestRunId: row.latest_run_id,
    activeRunId: row.active_run_id,
  };
}

function turnDto(row: TurnRow): ChatTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    role: row.role,
    text: row.text,
    createdAt: row.created_at.toISOString(),
  };
}

function runDto(row: RunRow): ChatRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    state: row.state,
    modelId: row.model_id,
    answer: row.answer,
    failureCode: row.failure_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastSequence: row.last_sequence,
  };
}

function eventDto(row: EventRow): ChatEvent {
  return {
    sequence: row.sequence,
    eventKey: row.event_key,
    type: row.type,
    text: row.text,
    state: row.state,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  };
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function promptFromSnapshot(snapshot: string, modelId: string): string {
  let value: unknown;
  try {
    value = JSON.parse(snapshot);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ChatError(400, 'INVALID_INPUT', 'Invalid chat snapshot.');
    throw error;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('modelId' in value) ||
    value.modelId !== modelId ||
    !('prompt' in value) ||
    typeof value.prompt !== 'string'
  )
    throw new ChatError(400, 'INVALID_INPUT', 'Invalid chat snapshot.');
  return value.prompt;
}

/** @id CODE-CHC-014 @implements REQ-CHC-003 */
function finalUserTextFromPrompt(prompt: string): string {
  let value: unknown;
  try {
    value = JSON.parse(prompt);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ChatError(400, 'INVALID_INPUT', 'Invalid chat snapshot.');
    throw error;
  }
  if (!Array.isArray(value)) throw new ChatError(400, 'INVALID_INPUT', 'Invalid chat snapshot.');
  const last = value.at(-1);
  if (
    typeof last !== 'object' ||
    last === null ||
    !('role' in last) ||
    last.role !== 'user' ||
    !('text' in last) ||
    typeof last.text !== 'string'
  )
    throw new ChatError(400, 'INVALID_INPUT', 'Invalid chat snapshot.');
  return last.text;
}

/** @id CODE-CHH-002 @implements REQ-CHH-001 REQ-CHH-002 REQ-CHH-003 REQ-CHH-004 */
export class ChatRepository {
  private readonly jobs: JobRepository;

  constructor(private readonly pool: Pool) {
    this.jobs = new JobRepository(pool);
  }

  private async authorizeProject(
    client: PoolClient,
    owner: Principal,
    project: string,
    lock: boolean,
  ): Promise<void> {
    if (!uuid.safeParse(project).success) throw missing();
    const result = await client.query(
      `SELECT id FROM projects
       WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()}
       ${lock ? 'FOR UPDATE' : ''}`,
      [project, owner.tenantId, owner.objectId],
    );
    if (!result.rowCount) throw missing();
  }

  private async write<T>(
    owner: Principal,
    project: string,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.jobs.transaction(async (client) => {
      await this.authorizeProject(client, owner, project, true);
      await this.jobs.reconcile(client);
      return action(client);
    });
  }

  private async read<T>(
    owner: Principal,
    project: string,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.jobs.transaction(async (client) => {
      await this.authorizeProject(client, owner, project, false);
      await this.jobs.reconcile(client);
      return action(client);
    });
  }

  async createConversation(owner: Principal, project: string): Promise<ChatConversation> {
    return this.write(owner, project, async (client) => {
      const row = (
        await client.query<ConversationRow>(
          `INSERT INTO chat_conversations(id,tenant_id,owner_oid,project_id)
           VALUES($1,$2,$3,$4)
           RETURNING id,created_at,updated_at,history_revision,preview,latest_run_id,active_run_id`,
          [randomUUID(), owner.tenantId, owner.objectId, project],
        )
      ).rows[0];
      if (!row) throw new Error('Chat conversation insert returned no row.');
      return conversationDto(row);
    });
  }

  async listConversations(
    owner: Principal,
    project: string,
    cursor?: string,
  ): Promise<ChatPage<ChatConversation>> {
    return this.read(owner, project, async (client) => {
      const position = parseConversationCursor(cursor);
      const rows = (
        await client.query<ConversationRow>(
          `SELECT id,created_at,updated_at,history_revision,preview,latest_run_id,active_run_id
           FROM chat_conversations WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3
             AND ($4::timestamptz IS NULL OR created_at<$4 OR (created_at=$4 AND id>$5::uuid))
           ORDER BY created_at DESC,id ASC LIMIT 101`,
          [owner.tenantId, owner.objectId, project, position?.[0] ?? null, position?.[1] ?? null],
        )
      ).rows;
      const items = rows.slice(0, pageSize).map(conversationDto);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > pageSize && last ? encodeCursor([last.createdAt, last.id]) : null,
      };
    });
  }

  async getConversation(
    owner: Principal,
    project: string,
    id: string,
  ): Promise<ChatConversation> {
    if (!uuid.safeParse(id).success) throw missing();
    return this.read(owner, project, async (client) => {
      const row = (
        await client.query<ConversationRow>(
          `SELECT id,created_at,updated_at,history_revision,preview,latest_run_id,active_run_id
           FROM chat_conversations
           WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4`,
          [id, owner.tenantId, owner.objectId, project],
        )
      ).rows[0];
      if (!row) throw missing();
      return conversationDto(row);
    });
  }

  /** @id CODE-CHC-011 @implements REQ-CHC-003 */
  async admitConfirmed(
    owner: Principal,
    project: string,
    conversation: string,
    input: ChatAdmission | ChatPreviewAdmission,
  ): Promise<ChatRun> {
    const previewAdmission = 'previewId' in input;
    if (!keySchema.safeParse(input.idempotencyKey).success || !/^[a-f0-9]{64}$/.test(input.snapshotHash))
      throw new ChatError(400, 'INVALID_INPUT', 'Invalid confirmed chat input.');
    if (
      (previewAdmission &&
        (!uuid.safeParse(input.previewId).success ||
          !uuid.safeParse(input.connectionId).success ||
          !uuid.safeParse(input.connectionGeneration).success)) ||
      (!previewAdmission &&
        (typeof input.modelId !== 'string' ||
          input.modelId.length < 1 ||
          input.modelId.length > 128 ||
          typeof input.snapshot !== 'string' ||
          Buffer.byteLength(input.snapshot) < 1 ||
          Buffer.byteLength(input.snapshot) > 262144))
    )
      throw new ChatError(400, 'INVALID_INPUT', 'Invalid confirmed chat input.');

    return this.write(owner, project, async (client) => {
      if (!uuid.safeParse(conversation).success) throw missing();
      const found = (
        await client.query(
          `SELECT id FROM chat_conversations
           WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4 FOR UPDATE`,
          [conversation, owner.tenantId, owner.objectId, project],
        )
      ).rows[0];
      if (!found) throw missing();

      const existing = (
        await client.query<RunRow>(
          `SELECT id,preview_id,conversation_id,state,model_id,snapshot_hash,answer,failure_code,created_at,updated_at,
                  last_sequence,assistant_turn_sequence
           FROM chat_runs
           WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3 AND conversation_id=$4
              AND idempotency_key=$5 FOR UPDATE`,
           [owner.tenantId, owner.objectId, project, conversation, input.idempotencyKey],
        )
      ).rows[0];
      if (existing) {
        const same =
          existing.snapshot_hash === input.snapshotHash &&
          (previewAdmission
            ? existing.preview_id === input.previewId
            : existing.preview_id == null && existing.model_id === input.modelId);
        if (!same)
          throw new ChatError(409, 'IDEMPOTENCY_CONFLICT', 'Chat key already has different input.');
        return runDto(existing);
      }

      let modelId: string;
      let snapshot: string;
      if (previewAdmission) {
        const preview = (
          await client.query<{
            id: string;
            model_id: string;
            snapshot: string;
            snapshot_hash: string;
            project_version: number;
            history_revision: number;
            connection_id: string;
            connection_generation: string;
            expires: boolean;
            superseded_at: Date | null;
            consumed_at: Date | null;
          }>(
            `SELECT id,model_id,snapshot,snapshot_hash,project_version,history_revision,connection_id,
                    connection_generation,expires_at>clock_timestamp() AS expires,
                    superseded_at,consumed_at
             FROM chat_previews
             WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4 AND conversation_id=$5
             FOR UPDATE`,
            [input.previewId, owner.tenantId, owner.objectId, project, conversation],
          )
        ).rows[0];
        if (
          !preview ||
          preview.snapshot_hash !== input.snapshotHash ||
          preview.superseded_at ||
          !preview.expires ||
          preview.consumed_at
        )
          throw new ChatError(409, 'CONSENT_REQUIRED', 'Preview is no longer available; prepare again.');

        const current = (
          await client.query<{
            history_revision: number;
            project_version: number;
            connection_id: string | null;
            generation: string;
          }>(
            `SELECT c.history_revision,o.connection_id,o.generation,p.version AS project_version
             FROM chat_conversations c
             JOIN copilot_owners o ON o.tenant_id=c.tenant_id AND o.object_id=c.owner_oid
             JOIN projects p ON p.id=c.project_id AND p.tenant_id=c.tenant_id
               AND p.owner_oid=c.owner_oid
             WHERE c.id=$1 AND c.tenant_id=$2 AND c.owner_oid=$3 AND c.project_id=$4
             FOR UPDATE OF c,o,p`,
            [conversation, owner.tenantId, owner.objectId, project],
          )
        ).rows[0];
        if (
          !current ||
          current.project_version !== preview.project_version ||
          current.history_revision !== preview.history_revision ||
          current.connection_id !== preview.connection_id ||
          current.generation !== preview.connection_generation ||
          input.connectionId !== preview.connection_id ||
          input.connectionGeneration !== preview.connection_generation
        )
          throw new ChatError(409, 'CONSENT_REQUIRED', 'Conversation or connection changed; prepare again.');

        const catalog = (
          await client.query<{
            models: unknown;
            connection_id: string;
            connection_generation: string;
            expires: boolean;
          }>(
            `SELECT models,connection_id,connection_generation,
                    expires_at>clock_timestamp() AS expires
             FROM chat_model_catalogs
             WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3 FOR UPDATE`,
            [owner.tenantId, owner.objectId, project],
          )
        ).rows[0];
        let models: ReturnType<typeof parseModelInventory>;
        try {
          models = parseModelInventory(catalog?.models);
        } catch {
          throw new ChatError(409, 'CONSENT_REQUIRED', 'Model availability changed; prepare again.');
        }
        if (
          !catalog ||
          !catalog.expires ||
          catalog.connection_id !== preview.connection_id ||
          catalog.connection_generation !== preview.connection_generation ||
          !models.some((model) => model.id === preview.model_id)
        )
          throw new ChatError(409, 'CONSENT_REQUIRED', 'Model availability changed; prepare again.');

        modelId = preview.model_id;
        snapshot = preview.snapshot;
      } else {
        modelId = input.modelId;
        snapshot = input.snapshot;
      }
      if (Buffer.byteLength(snapshot, 'utf8') < 1 || Buffer.byteLength(snapshot, 'utf8') > 262144)
        throw new ChatError(413, 'INVALID_INPUT', 'Chat context exceeds the supported size.');
      if (createHash('sha256').update(snapshot, 'utf8').digest('hex') !== input.snapshotHash)
        throw new ChatError(400, 'INVALID_INPUT', 'Invalid confirmed chat input.');
      const prompt = promptFromSnapshot(snapshot, modelId);
      const userText = previewAdmission ? finalUserTextFromPrompt(prompt) : prompt;

      /** @id CODE-CHR-001 @implements REQ-CHR-001 */
      const busy = await client.query(
        `SELECT 1 FROM chat_runs WHERE tenant_id=$1 AND owner_oid=$2
         AND state IN ('queued','running','cancel_requested') LIMIT 1`,
        [owner.tenantId, owner.objectId],
      );
      if (busy.rowCount)
        throw new ChatError(409, 'CHAT_BUSY', 'An active chat run already exists.');

      const id = randomUUID();
      const next = (
        await client.query<{ sequence: number }>(
          'SELECT COALESCE(MAX(sequence),0)::int AS sequence FROM chat_turns WHERE conversation_id=$1',
          [conversation],
        )
      ).rows[0]?.sequence;
      if (next === undefined || next > 2147483645)
        throw new ChatError(409, 'CHAT_BUSY', 'Conversation history is full.');
      const userSequence = next + 1;
      const assistantSequence = next + 2;
      const job = await this.jobs.enqueueWithin(
        client,
        owner,
        project,
        `chat:${id}`,
        'chat.generate',
        { runId: id },
      );
      const run = (
        await client.query<RunRow>(
          `INSERT INTO chat_runs(id,job_id,tenant_id,owner_oid,project_id,conversation_id,
             idempotency_key,model_id,snapshot,snapshot_hash,assistant_turn_sequence,state,preview_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12)
           RETURNING id,conversation_id,state,model_id,answer,failure_code,created_at,updated_at,
                     last_sequence,assistant_turn_sequence`,
          [
            id,
            job.job.id,
            owner.tenantId,
            owner.objectId,
            project,
            conversation,
            input.idempotencyKey,
            modelId,
            snapshot,
            input.snapshotHash,
            assistantSequence,
            previewAdmission ? input.previewId : null,
          ],
        )
      ).rows[0];
      if (!run) throw new Error('Chat run insert returned no row.');
      if (previewAdmission) {
        const consumed = await client.query(
          `UPDATE chat_previews SET consumed_at=clock_timestamp(),consumed_key=$2,consumed_run_id=$3
           WHERE id=$1 AND consumed_at IS NULL AND superseded_at IS NULL`,
          [input.previewId, input.idempotencyKey, id],
        );
        if (consumed.rowCount !== 1)
          throw new ChatError(409, 'CONSENT_REQUIRED', 'Preview was already consumed; prepare again.');
      }
      const turns = await client.query(
        `INSERT INTO chat_turns(id,tenant_id,owner_oid,project_id,conversation_id,sequence,role,text)
         VALUES($1,$2,$3,$4,$5,$6,'user',$7),($8,$2,$3,$4,$5,$9,'assistant','')`,
        [
          randomUUID(),
          owner.tenantId,
          owner.objectId,
          project,
          conversation,
          userSequence,
          userText,
          randomUUID(),
          assistantSequence,
        ],
      );
      if (turns.rowCount !== 2) throw new Error('Chat turn admission was incomplete.');
      const updated = await client.query(
        `UPDATE chat_conversations SET
           history_revision=history_revision+3,preview=$5,latest_run_id=$6,active_run_id=$6,
           updated_at=clock_timestamp()
         WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4`,
        [
          conversation,
          owner.tenantId,
          owner.objectId,
          project,
          Array.from(userText).slice(0, 240).join(''),
          id,
        ],
      );
      if (!updated.rowCount) throw missing();
      return runDto(run);
    });
  }

  /** @id CODE-CHC-012 @implements REQ-CHC-003 */
  async replayConfirmed(
    owner: Principal,
    project: string,
    conversation: string,
    input: Pick<ChatPreviewAdmission, 'idempotencyKey' | 'previewId' | 'snapshotHash'>,
  ): Promise<ChatRun | null> {
    if (
      !keySchema.safeParse(input.idempotencyKey).success ||
      !uuid.safeParse(input.previewId).success ||
      !/^[a-f0-9]{64}$/.test(input.snapshotHash)
    )
      throw new ChatError(400, 'INVALID_INPUT', 'Invalid confirmed chat input.');
    if (!uuid.safeParse(conversation).success) throw missing();
    return this.read(owner, project, async (client) => {
      const existing = (
        await client.query<RunRow>(
          `SELECT id,preview_id,conversation_id,state,model_id,snapshot_hash,answer,failure_code,
                  created_at,updated_at,last_sequence,assistant_turn_sequence
           FROM chat_runs
           WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3 AND conversation_id=$4
             AND idempotency_key=$5`,
          [owner.tenantId, owner.objectId, project, conversation, input.idempotencyKey],
        )
      ).rows[0];
      if (!existing) return null;
      if (existing.preview_id !== input.previewId || existing.snapshot_hash !== input.snapshotHash)
        throw new ChatError(409, 'IDEMPOTENCY_CONFLICT', 'Chat key already has different input.');
      return runDto(existing);
    });
  }

  async listTurns(
    owner: Principal,
    project: string,
    conversation: string,
    cursor?: string,
  ): Promise<ChatPage<ChatTurn>> {
    if (!uuid.safeParse(conversation).success) throw missing();
    return this.read(owner, project, async (client) => {
      const found = await client.query(
        `SELECT 1 FROM chat_conversations
         WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4`,
        [conversation, owner.tenantId, owner.objectId, project],
      );
      if (!found.rowCount) throw missing();
      const after = parseTurnCursor(cursor);
      const rows = (
        await client.query<TurnRow>(
          `SELECT id,conversation_id,sequence,role,text,created_at FROM chat_turns
           WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT 101`,
          [conversation, after],
        )
      ).rows;
      const items = rows.slice(0, pageSize).map(turnDto);
      const last = items.at(-1);
      return {
        items,
      nextCursor: rows.length > pageSize && last ? encodeCursor(last.sequence) : null,
      };
    });
  }

  /** @id CODE-CHR-004 @implements REQ-CHR-004 */
  async appendEvent(claim: JobClaim, event: ChatDelta): Promise<ChatEvent | null> {
    if (
      !keySchema.safeParse(event.eventKey).success ||
      typeof event.text !== 'string' ||
      Buffer.byteLength(event.text) > 16384
    )
      throw new ChatError(400, 'INVALID_INPUT', 'Invalid chat event.');
    return this.jobs.transaction(async (client) => {
      await this.authorizeProject(client, claim.owner, claim.job.projectId, true);
      const run = (
        await client.query<RunRow>(
          `SELECT r.id,r.conversation_id,r.state,r.model_id,r.answer,r.failure_code,r.created_at,
                  r.updated_at,r.last_sequence,r.assistant_turn_sequence
           FROM durable_jobs j JOIN chat_runs r ON r.job_id=j.id
           WHERE j.id=$1 AND j.type='chat.generate' AND j.tenant_id=$2 AND j.owner_oid=$3
             AND j.project_id=$4 AND j.fence=$5
             AND j.state IN ('running','cancel_requested') AND j.lease_until>clock_timestamp()
             AND j.started_at+interval '300 seconds'>clock_timestamp()
             AND (j.cancel_deadline IS NULL OR j.cancel_deadline>clock_timestamp())
           FOR UPDATE OF r`,
          [
            claim.job.id,
            claim.owner.tenantId,
            claim.owner.objectId,
            claim.job.projectId,
            claim.fence,
          ],
        )
      ).rows[0];
      if (!run) return null;
      const duplicate = (
        await client.query<EventRow>(
          `SELECT sequence,event_key,type,text,state,reason,created_at
           FROM chat_events WHERE run_id=$1 AND event_key=$2`,
          [run.id, event.eventKey],
        )
      ).rows[0];
      if (duplicate) {
        if (duplicate.type !== event.type || duplicate.text !== event.text)
          throw new ChatError(409, 'IDEMPOTENCY_CONFLICT', 'Chat event key has different content.');
        return eventDto(duplicate);
      }
      const answer = run.answer + event.text;
      if (Buffer.byteLength(answer, 'utf8') > 1_000_000)
        throw new ChatError(400, 'INVALID_INPUT', 'Chat answer exceeds the supported size.');
      if (run.last_sequence === 2147483647)
        throw new ChatError(409, 'FUTURE_SEQUENCE', 'Chat event sequence is exhausted.');
      const sequence = run.last_sequence + 1;
      const created = (
        await client.query<EventRow>(
          `INSERT INTO chat_events(run_id,tenant_id,owner_oid,project_id,sequence,event_key,type,text)
           VALUES($1,$2,$3,$4,$5,$6,'delta',$7)
           RETURNING sequence,event_key,type,text,state,reason,created_at`,
          [
            run.id,
            claim.owner.tenantId,
            claim.owner.objectId,
            claim.job.projectId,
            sequence,
            event.eventKey,
            event.text,
          ],
        )
      ).rows[0];
      if (!created) throw new Error('Chat event insert returned no row.');
      const changed = await client.query(
        `UPDATE chat_runs SET answer=$2,last_sequence=$3,updated_at=clock_timestamp()
         WHERE id=$1`,
        [run.id, answer, sequence],
      );
      if (!changed.rowCount) throw new Error('Chat run answer update returned no row.');
      const turn = await client.query(
        `UPDATE chat_turns SET text=$2 WHERE conversation_id=$1 AND sequence=$3`,
        [run.conversation_id, answer, run.assistant_turn_sequence],
      );
      if (!turn.rowCount) throw new Error('Chat assistant turn is missing.');
      const conversation = await client.query(
        `UPDATE chat_conversations SET
           history_revision=history_revision+1,preview=$2,updated_at=clock_timestamp()
         WHERE id=$1`,
        [run.conversation_id, Array.from(answer).slice(0, 240).join('')],
      );
      if (!conversation.rowCount) throw new Error('Chat conversation update returned no row.');
      return eventDto(created);
    });
  }

  async listEvents(
    owner: Principal,
    project: string,
    runId: string,
    after: number,
  ): Promise<ChatRunEventPage> {
    if (!uuid.safeParse(runId).success) throw missing();
    if (!Number.isSafeInteger(after) || after < 0 || after > 2147483647)
      throw new ChatError(400, 'INVALID_INPUT', 'Invalid chat event sequence.');
    return this.read(owner, project, async (client) => {
      const run = (
        await client.query<RunRow>(
          `SELECT id,conversation_id,state,model_id,answer,failure_code,created_at,updated_at,
                  last_sequence,assistant_turn_sequence
           FROM chat_runs WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4`,
          [runId, owner.tenantId, owner.objectId, project],
        )
      ).rows[0];
      if (!run) throw missing();
      if (after > run.last_sequence)
        throw new ChatError(409, 'FUTURE_SEQUENCE', 'Requested chat sequence is in the future.');
      const rows = (
        await client.query<EventRow>(
          `SELECT sequence,event_key,type,text,state,reason,created_at FROM chat_events
           WHERE run_id=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT 101`,
          [runId, after],
        )
      ).rows;
      const items = rows.slice(0, pageSize).map(eventDto);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > pageSize && last ? String(last.sequence) : null,
        run: runDto(run),
        lastSequence: run.last_sequence,
      };
    });
  }

  async getRun(owner: Principal, project: string, runId: string): Promise<ChatRun> {
    if (!uuid.safeParse(runId).success) throw missing();
    return this.read(owner, project, async (client) => {
      const row = (
        await client.query<RunRow>(
          `SELECT id,conversation_id,state,model_id,answer,failure_code,created_at,updated_at,
                  last_sequence,assistant_turn_sequence
           FROM chat_runs WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4`,
          [runId, owner.tenantId, owner.objectId, project],
        )
      ).rows[0];
      if (!row) throw missing();
      return runDto(row);
    });
  }

  /** @id CODE-CHC-013 @implements REQ-CHC-004 */
  async dispatchInput(
    claim: JobClaim,
    runId: string,
  ): Promise<{
    modelId: string;
    prompt: string;
    snapshotHash: string;
    connectionId: string;
    connectionGeneration: string;
  }> {
    if (!uuid.safeParse(runId).success) throw missing();
    return this.jobs.transaction(async (client) => {
      await this.authorizeProject(client, claim.owner, claim.job.projectId, true);
      const row = (
        await client.query<{
          model_id: string;
          snapshot: string;
          snapshot_hash: string;
          preview_id: string;
          connection_id: string;
          connection_generation: string;
        }>(
          `SELECT r.model_id,r.snapshot,r.snapshot_hash,r.preview_id,
                  p.connection_id,p.connection_generation
           FROM durable_jobs j
           JOIN chat_runs r ON r.job_id=j.id
           JOIN chat_previews p ON p.id=r.preview_id
           WHERE j.id=$1 AND j.type='chat.generate' AND j.tenant_id=$2 AND j.owner_oid=$3
             AND j.project_id=$4 AND j.fence=$5 AND j.state='running'
             AND j.lease_until>clock_timestamp()
             AND (j.cancel_deadline IS NULL OR j.cancel_deadline>clock_timestamp())
             AND j.started_at+interval '300 seconds'>clock_timestamp()
             AND r.id=$6 AND r.state='running'
           FOR UPDATE OF j,r,p`,
          [
            claim.job.id,
            claim.owner.tenantId,
            claim.owner.objectId,
            claim.job.projectId,
            claim.fence,
            runId,
          ],
        )
      ).rows[0];
      if (!row) throw new ChatError(409, 'CHAT_UNAVAILABLE', 'Chat dispatch is no longer available.');
      if (createHash('sha256').update(row.snapshot, 'utf8').digest('hex') !== row.snapshot_hash)
        throw new ChatError(409, 'CHAT_UNAVAILABLE', 'Confirmed chat input failed integrity checks.');
      return {
        modelId: row.model_id,
        prompt: promptFromSnapshot(row.snapshot, row.model_id),
        snapshotHash: row.snapshot_hash,
        connectionId: row.connection_id,
        connectionGeneration: row.connection_generation,
      };
    });
  }

  async cancelRun(owner: Principal, project: string, runId: string): Promise<ChatRun> {
    if (!uuid.safeParse(runId).success) throw missing();
    return this.write(owner, project, async (client) => {
      const row = (
        await client.query<RunRow>(
          `SELECT id,job_id,conversation_id,state,model_id,answer,failure_code,created_at,
                  updated_at,last_sequence,assistant_turn_sequence
           FROM chat_runs WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4 FOR UPDATE`,
          [runId, owner.tenantId, owner.objectId, project],
        )
      ).rows[0];
      if (!row?.job_id) throw missing();
      await this.jobs.cancelWithin(client, owner, project, row.job_id);
      const current = (
        await client.query<RunRow>(
          `SELECT id,conversation_id,state,model_id,answer,failure_code,created_at,updated_at,
                  last_sequence,assistant_turn_sequence
           FROM chat_runs WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4`,
          [runId, owner.tenantId, owner.objectId, project],
        )
      ).rows[0];
      if (!current) throw missing();
      return runDto(current);
    });
  }

  async settle(claim: JobClaim, event: 'stop_ack' | 'success' | 'error', interrupted = false) {
    return this.jobs.transaction(async (client) => {
      await this.authorizeProject(client, claim.owner, claim.job.projectId, true);
      await this.jobs.reconcile(client);
      const completed = await this.jobs.finishWithin(
        client,
        claim,
        interrupted ? 'error' : event,
        interrupted ? 'interrupted' : 'handler_failed',
      );
      if (completed || interrupted || event === 'stop_ack') return completed;
      return this.jobs.finishWithin(client, claim, 'stop_ack');
    });
  }

  async ready(): Promise<void> {
    const result = await this.pool.query<{
      conversations: string | null;
      turns: string | null;
      runs: string | null;
      events: string | null;
      jobs: string | null;
    }>(
      `SELECT to_regclass('chat_conversations')::text AS conversations,
              to_regclass('chat_turns')::text AS turns,
              to_regclass('chat_runs')::text AS runs,
              to_regclass('chat_events')::text AS events,
              to_regclass('durable_jobs')::text AS jobs`,
    );
    if (
      !result.rows[0]?.conversations ||
      !result.rows[0].turns ||
      !result.rows[0].runs ||
      !result.rows[0].events ||
      !result.rows[0].jobs
    )
      throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Chat is unavailable.');
  }
}
