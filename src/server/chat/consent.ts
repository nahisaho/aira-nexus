import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Principal } from '../../shared/contracts.js';
import { ChatError } from './errors.js';
import { activeProjectPredicate } from '../projects.js';
import type { ChatCredentialBinding } from '../copilot/service.js';
import type { CopilotService } from '../copilot/service.js';
import { parseModelInventory } from './models.js';
import { createChatSnapshot, type SnapshotTurn } from './snapshot.js';
import type { ChatRuntime } from './runtime.js';
import type { ChatRepository } from './repository.js';
import type { ChatRun } from '../../shared/chat.js';

export interface PrepareInput {
  text: string;
  modelId: string;
}

export interface ConfirmInput {
  previewId: string;
  snapshotHash: string;
  confirmed: true;
}

export interface ChatPreview {
  previewId: string;
  modelId: string;
  snapshot: string;
  prompt: string;
  snapshotHash: string;
  expiresAt: string;
}

const prepareSchema = z.strictObject({
  text: z.string(),
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
});
const confirmSchema = z.strictObject({
  previewId: z.uuid(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});

function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** @id CODE-CHC-003 @implements REQ-CHC-002 */
export function parsePrepareInput(value: unknown): PrepareInput {
  const parsed = prepareSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.text.trim().length === 0 ||
    parsed.data.text.includes('\0') ||
    !wellFormedUtf16(parsed.data.text) ||
    Buffer.byteLength(parsed.data.text, 'utf8') > 8192
  )
    throw new ChatError(400, 'INVALID_INPUT', 'Invalid chat preview input.');
  return parsed.data;
}

/** @id CODE-CHC-004 @implements REQ-CHC-003 */
export function parseConfirmInput(value: unknown, idempotencyKey: string | null): ConfirmInput {
  const parsed = confirmSchema.safeParse(value);
  if (!parsed.success || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey ?? ''))
    throw new ChatError(400, 'INVALID_INPUT', 'Invalid chat confirmation input.');
  return parsed.data;
}

/** @id CODE-CHC-006 @implements REQ-CHC-001 REQ-CHC-002 */
export class ChatConsentRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async authorizeProject(
    client: PoolClient,
    owner: Principal,
    project: string,
  ): Promise<number> {
    const result = await client.query<{ version: number }>(
      `SELECT version FROM projects
       WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND ${activeProjectPredicate()}
       FOR UPDATE`,
      [project, owner.tenantId, owner.objectId],
    );
    const row = result.rows[0];
    if (!row) throw new ChatError(404, 'NOT_FOUND', 'Project not found.');
    return row.version;
  }

  async assertProject(owner: Principal, project: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.authorizeProject(client, owner, project);
    });
  }

  async saveModels(
    owner: Principal,
    project: string,
    binding: ChatCredentialBinding,
    input: unknown,
  ): Promise<{ models: ReturnType<typeof parseModelInventory>; expiresAt: string }> {
    const models = parseModelInventory(input);
    return this.transaction(async (client) => {
      await this.authorizeProject(client, owner, project);
      const result = await client.query<{ expires_at: Date }>(
        `INSERT INTO chat_model_catalogs(id,tenant_id,owner_oid,project_id,connection_id,
           connection_generation,models,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,clock_timestamp()+interval '300 seconds')
         ON CONFLICT(tenant_id,owner_oid,project_id) DO UPDATE SET
           id=EXCLUDED.id,connection_id=EXCLUDED.connection_id,
           connection_generation=EXCLUDED.connection_generation,models=EXCLUDED.models,
           expires_at=EXCLUDED.expires_at,created_at=clock_timestamp()
         RETURNING expires_at`,
        [
          randomUUID(),
          owner.tenantId,
          owner.objectId,
          project,
          binding.connectionId,
          binding.generation,
          JSON.stringify(models),
        ],
      );
      const expiresAt = result.rows[0]?.expires_at;
      if (!expiresAt) throw new Error('Model catalog insert returned no row.');
      return { models, expiresAt: expiresAt.toISOString() };
    });
  }

  async createPreview(
    owner: Principal,
    project: string,
    conversation: string,
    input: PrepareInput,
    binding: ChatCredentialBinding,
  ): Promise<ChatPreview> {
    return this.transaction(async (client) => {
      const projectVersion = await this.authorizeProject(client, owner, project);
      const current = (
        await client.query<{ history_revision: number }>(
          `SELECT history_revision FROM chat_conversations
           WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4 FOR UPDATE`,
          [conversation, owner.tenantId, owner.objectId, project],
        )
      ).rows[0];
      if (!current) throw new ChatError(404, 'NOT_FOUND', 'Conversation not found.');

      const catalog = (
        await client.query<{
          connection_id: string;
          connection_generation: string;
          models: unknown;
          expires_at: Date;
          current: boolean;
        }>(
          `SELECT connection_id,connection_generation,models,expires_at,
             expires_at>clock_timestamp() AS current
           FROM chat_model_catalogs WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3 FOR UPDATE`,
          [owner.tenantId, owner.objectId, project],
        )
      ).rows[0];
      if (
        !catalog ||
        !catalog.current ||
        catalog.connection_id !== binding.connectionId ||
        catalog.connection_generation !== binding.generation
      )
        throw new ChatError(
          409,
          'CONSENT_REQUIRED',
          'Refresh model availability and prepare again.',
        );
      const models = parseModelInventory(catalog.models);
      if (!models.some((model) => model.id === input.modelId))
        throw new ChatError(
          409,
          'CONSENT_REQUIRED',
          'Refresh model availability and prepare again.',
        );

      const turns = await client.query<SnapshotTurn>(
        `SELECT role,text FROM chat_turns
         WHERE conversation_id=$1 ORDER BY sequence ASC`,
        [conversation],
      );
      const snapshot = createChatSnapshot(input.modelId, turns.rows, input.text);
      if (Buffer.byteLength(snapshot.snapshot, 'utf8') > 262144)
        throw new ChatError(413, 'INVALID_INPUT', 'Chat context exceeds the supported size.');

      await client.query(
        `UPDATE chat_previews SET superseded_at=clock_timestamp()
         WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3 AND conversation_id=$4
           AND consumed_at IS NULL AND superseded_at IS NULL`,
        [owner.tenantId, owner.objectId, project, conversation],
      );
      const preview = (
        await client.query<{ id: string; expires_at: Date }>(
          `INSERT INTO chat_previews(id,tenant_id,owner_oid,project_id,conversation_id,model_id,
             snapshot,snapshot_hash,project_version,history_revision,connection_id,connection_generation,
             expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+interval '300 seconds')
           RETURNING id,expires_at`,
          [
            randomUUID(),
            owner.tenantId,
            owner.objectId,
            project,
            conversation,
            input.modelId,
            snapshot.snapshot,
            snapshot.hash,
            projectVersion,
            current.history_revision,
            binding.connectionId,
            binding.generation,
          ],
        )
      ).rows[0];
      if (!preview) throw new Error('Chat preview insert returned no row.');
      return {
        previewId: preview.id,
        modelId: input.modelId,
        snapshot: snapshot.snapshot,
        prompt: snapshot.prompt,
        snapshotHash: snapshot.hash,
        expiresAt: preview.expires_at.toISOString(),
      };
    });
  }
}

/** @id CODE-CHC-009 @implements REQ-CHC-001 REQ-CHC-002 REQ-CHC-003 */
export class ChatConsentService {
  constructor(
    private readonly repository: ChatConsentRepository,
    private readonly copilot: CopilotService,
    private readonly runtime: ChatRuntime,
  ) {}

  async discoverModels(
    owner: Principal,
    project: string,
    confirmed: boolean,
  ): Promise<{ models: ReturnType<typeof parseModelInventory>; expiresAt: string }> {
    if (confirmed !== true)
      throw new ChatError(
        400,
        'INVALID_INPUT',
        'Explicit model discovery confirmation is required.',
      );
    await this.repository.assertProject(owner, project);
    const binding = await this.copilot.chatCredential(owner);
    let response: unknown[];
    try {
      response = await this.runtime.listModels(binding.token);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(JSON.stringify({ event: 'chat_model_discovery_failed' }));
      throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Model discovery is unavailable.');
    }
    const models = parseModelInventory(response);
    await this.copilot.currentChatCredential(owner, binding);
    return this.repository.saveModels(owner, project, binding, models);
  }

  async createPreview(
    owner: Principal,
    project: string,
    conversation: string,
    value: unknown,
  ): Promise<ChatPreview> {
    const input = parsePrepareInput(value);
    await this.repository.assertProject(owner, project);
    const binding = await this.copilot.chatCredential(owner);
    return this.repository.createPreview(owner, project, conversation, input, binding);
  }

  async confirmPreview(
    owner: Principal,
    project: string,
    conversation: string,
    value: unknown,
    idempotencyKey: string | null,
    chat: ChatRepository,
  ): Promise<ChatRun> {
    const key = idempotencyKey ?? '';
    const input = parseConfirmInput(value, key);
    const replay = await chat.replayConfirmed(owner, project, conversation, {
      previewId: input.previewId,
      snapshotHash: input.snapshotHash,
      idempotencyKey: key,
    });
    if (replay) return replay;
    await this.repository.assertProject(owner, project);
    const binding = await this.copilot.chatCredential(owner);
    await this.copilot.currentChatCredential(owner, binding);
    return chat.admitConfirmed(owner, project, conversation, {
      previewId: input.previewId,
      snapshotHash: input.snapshotHash,
      idempotencyKey: key,
      connectionId: binding.connectionId,
      connectionGeneration: binding.generation,
    });
  }
}
