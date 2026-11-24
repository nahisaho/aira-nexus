import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Principal } from '../../shared/contracts.js';
import { copilotTransition } from '../../shared/copilot.js';
import type {
  CopilotAttempt,
  CopilotEvent,
  CopilotState,
  CopilotStatus,
} from '../../shared/copilot.js';
import type { DeviceProvider, DeviceResult } from './provider.js';
import type { TokenVault } from './secrets.js';
import { CopilotError } from './errors.js';
interface OwnerRow {
  generation: string;
  current_attempt_id: string | null;
  start_after: Date;
  connection_id: string | null;
  access_token: string | null;
  token_expires_at: Date | null;
  reconnect_required: boolean;
}
interface AttemptRow {
  id: string;
  generation: string;
  state: CopilotState;
  created_at: Date;
  expires_at: Date;
  next_poll_at: Date;
  interval_seconds: number;
  retry_count: number;
  lease_id: string | null;
  lease_until: Date | null;
  device_code: string | null;
  user_code: string | null;
}

export interface ChatCredentialBinding {
  token: string;
  connectionId: string;
  generation: string;
}
const unfinished = (state: CopilotState) => state === 'starting' || state === 'pending';
const missing = () => new CopilotError(404, 'NOT_FOUND', 'Connection attempt not found.');
const corrupt = () =>
  new CopilotError(
    503,
    'COPILOT_STATE_UNAVAILABLE',
    'GitHub connection state is unavailable. Contact the administrator.',
  );
const limited = (until: number, now: number) =>
  new CopilotError(
    429,
    'COPILOT_RATE_LIMITED',
    'Wait before checking GitHub authorization again.',
    Math.max(1, Math.ceil((until - now) / 1000)),
  );

/** @id CODE-CON-004 @implements REQ-CON-002 REQ-CON-003 REQ-CON-004 */
export class CopilotService {
  constructor(
    private readonly options: {
      pool: Pool;
      provider: DeviceProvider;
      secrets: TokenVault;
      now?: () => number;
    },
  ) {}
  private async transaction<T>(
    owner: Principal,
    action: (client: PoolClient, row: OwnerRow, now: number) => Promise<T>,
  ): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO copilot_owners(tenant_id,object_id,generation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [owner.tenantId, owner.objectId, randomUUID()],
      );
      const row = (
        await client.query<OwnerRow>(
          'SELECT * FROM copilot_owners WHERE tenant_id=$1 AND object_id=$2 FOR UPDATE',
          [owner.tenantId, owner.objectId],
        )
      ).rows[0];
      if (!row) throw corrupt();
      const now = this.options.now?.() ?? Date.now();
      await client.query(
        `UPDATE copilot_attempts SET state=CASE WHEN state='starting' THEN 'failed' ELSE 'expired' END,
         device_code=NULL,user_code=NULL,lease_id=NULL,lease_until=NULL
         WHERE tenant_id=$1 AND object_id=$2 AND state IN ('starting','pending') AND expires_at <= $3`,
        [owner.tenantId, owner.objectId, new Date(now)],
      );
      if (row.token_expires_at && row.token_expires_at.getTime() <= now && row.access_token) {
        await client.query(
          'UPDATE copilot_owners SET access_token=NULL,reconnect_required=true WHERE tenant_id=$1 AND object_id=$2',
          [owner.tenantId, owner.objectId],
        );
        row.access_token = null;
        row.reconnect_required = true;
      }
      const result = await action(client, row, now);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query(
        error instanceof CopilotError && [404, 409, 429].includes(error.status)
          ? 'COMMIT'
          : 'ROLLBACK',
      );
      throw error;
    } finally {
      client.release();
    }
  }
  private async find(client: PoolClient, owner: Principal, id: string): Promise<AttemptRow> {
    const row = (
      await client.query<AttemptRow>(
        'SELECT * FROM copilot_attempts WHERE id=$1 AND tenant_id=$2 AND object_id=$3',
        [id, owner.tenantId, owner.objectId],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }
  private publicAttempt(owner: Principal, row: AttemptRow): CopilotAttempt {
    if (row.state === 'pending' && !row.user_code) throw corrupt();
    return {
      id: row.id,
      state: row.state,
      expiresAt: row.expires_at.toISOString(),
      nextPollAt: new Date(
        Math.max(row.next_poll_at.getTime(), row.lease_until?.getTime() ?? 0),
      ).toISOString(),
      ...(row.state === 'pending' && row.user_code
        ? {
            userCode: this.options.secrets.open(owner, row.id, 'user-code', row.user_code),
            verificationUri: 'https://github.com/login/device',
          }
        : {}),
    };
  }
  async status(owner: Principal): Promise<CopilotStatus> {
    return this.transaction(owner, async (client, row) => {
      if (row.access_token) {
        if (!row.connection_id) throw corrupt();
        this.options.secrets.open(owner, row.connection_id, 'access-token', row.access_token);
      }
      return {
        configured: true,
        status: row.access_token
          ? 'connected'
          : row.reconnect_required
            ? 'reconnect_required'
            : 'disconnected',
        attempt: row.current_attempt_id
          ? this.publicAttempt(owner, await this.find(client, owner, row.current_attempt_id))
          : null,
      };
    });
  }
  async credential(owner: Principal): Promise<string> {
    return this.transaction(owner, async (_client, row) => {
      if (!row.access_token || !row.connection_id)
        throw new CopilotError(409, 'COPILOT_CONNECTION_REQUIRED', 'Connect GitHub in settings.');
      return this.options.secrets.open(owner, row.connection_id, 'access-token', row.access_token);
    });
  }
  /** @id CODE-CHC-005 @implements REQ-CHC-004 */
  async chatCredential(owner: Principal): Promise<ChatCredentialBinding> {
    return this.transaction(owner, async (_client, row) => {
      if (!row.access_token || !row.connection_id)
        throw new CopilotError(409, 'COPILOT_CONNECTION_REQUIRED', 'Connect GitHub in settings.');
      return {
        token: this.options.secrets.open(
          owner,
          row.connection_id,
          'access-token',
          row.access_token,
        ),
        connectionId: row.connection_id,
        generation: row.generation,
      };
    });
  }
  async currentChatCredential(owner: Principal, binding: ChatCredentialBinding): Promise<string> {
    return this.transaction(owner, async (_client, row) => {
      if (!row.access_token || !row.connection_id)
        throw new CopilotError(409, 'COPILOT_CONNECTION_REQUIRED', 'Connect GitHub in settings.');
      const current = this.options.secrets.open(
        owner,
        row.connection_id,
        'access-token',
        row.access_token,
      );
      if (
        row.connection_id !== binding.connectionId ||
        row.generation !== binding.generation ||
        current !== binding.token
      )
        throw new CopilotError(409, 'COPILOT_CONNECTION_REQUIRED', 'Reconnect GitHub to continue.');
      return current;
    });
  }
  async revoke(owner: Principal, rejectedToken: string): Promise<boolean> {
    return this.transaction(owner, async (client, row) => {
      if (!row.access_token || !row.connection_id) return false;
      const current = this.options.secrets.open(
        owner,
        row.connection_id,
        'access-token',
        row.access_token,
      );
      if (current !== rejectedToken) return false;
      await client.query(
        `UPDATE copilot_owners SET access_token=NULL,token_expires_at=NULL,reconnect_required=true
         WHERE tenant_id=$1 AND object_id=$2`,
        [owner.tenantId, owner.objectId],
      );
      return true;
    });
  }
  private async transition(client: PoolClient, row: AttemptRow, event: CopilotEvent) {
    const state = copilotTransition(row.state, event);
    if (!state) throw corrupt();
    await client.query(
      `UPDATE copilot_attempts SET state=$2,
      device_code=CASE WHEN $2='pending' THEN device_code ELSE NULL END,
      user_code=CASE WHEN $2='pending' THEN user_code ELSE NULL END,
      lease_id=NULL,lease_until=NULL WHERE id=$1`,
      [row.id, state],
    );
    row.state = state;
    row.lease_id = null;
    row.lease_until = null;
    if (state !== 'pending') {
      row.device_code = null;
      row.user_code = null;
    }
  }
  async start(owner: Principal): Promise<CopilotAttempt> {
    const reservation = await this.transaction(owner, async (client, row, now) => {
      if (row.start_after.getTime() > now) throw limited(row.start_after.getTime(), now);
      await client.query(
        `UPDATE copilot_attempts SET state='cancelled',device_code=NULL,user_code=NULL,lease_id=NULL,lease_until=NULL
        WHERE tenant_id=$1 AND object_id=$2 AND state IN ('starting','pending')`,
        [owner.tenantId, owner.objectId],
      );
      const id = randomUUID(),
        generation = randomUUID();
      await client.query(
        'UPDATE copilot_owners SET generation=$3,current_attempt_id=$4,start_after=$5 WHERE tenant_id=$1 AND object_id=$2',
        [owner.tenantId, owner.objectId, generation, id, new Date(now + 30000)],
      );
      await client.query(
        `INSERT INTO copilot_attempts(id,tenant_id,object_id,generation,state,created_at,expires_at,next_poll_at)
        VALUES($1,$2,$3,$4,'starting',$5,$6,$6)`,
        [id, owner.tenantId, owner.objectId, generation, new Date(now), new Date(now + 15000)],
      );
      return { id, generation, started: now };
    });
    let grant;
    try {
      grant = await this.options.provider.start();
    } catch (error) {
      await this.transaction(owner, async (client, row) => {
        const attempt = await this.find(client, owner, reservation.id);
        if (row.generation === reservation.generation && attempt.state === 'starting')
          await this.transition(client, attempt, 'provider_error');
      });
      throw error;
    }
    return this.transaction(owner, async (client, row, now) => {
      const attempt = await this.find(client, owner, reservation.id);
      if (row.generation !== reservation.generation || attempt.state !== 'starting')
        return this.publicAttempt(owner, attempt);
      const expiresAt = reservation.started + Math.min(900, grant.expiresIn) * 1000;
      if (expiresAt <= now) {
        await this.transition(client, attempt, 'deadline');
        return this.publicAttempt(owner, attempt);
      }
      const interval = Math.max(5, grant.interval);
      const updated = (
        await client.query<AttemptRow>(
          `UPDATE copilot_attempts SET state='pending',expires_at=$2,next_poll_at=$3,
        interval_seconds=$4,device_code=$5,user_code=$6 WHERE id=$1 RETURNING *`,
          [
            attempt.id,
            new Date(expiresAt),
            new Date(now + interval * 1000),
            interval,
            this.options.secrets.seal(owner, attempt.id, 'device-code', grant.deviceCode),
            this.options.secrets.seal(owner, attempt.id, 'user-code', grant.userCode),
          ],
        )
      ).rows[0];
      if (!updated) throw corrupt();
      return this.publicAttempt(owner, updated);
    });
  }
  async poll(owner: Principal, id: string): Promise<CopilotAttempt> {
    const claim = await this.transaction(owner, async (client, row, now) => {
      const attempt = await this.find(client, owner, id);
      if (!unfinished(attempt.state)) return { public: this.publicAttempt(owner, attempt) };
      const until = Math.max(attempt.next_poll_at.getTime(), attempt.lease_until?.getTime() ?? 0);
      if (attempt.state === 'starting' || until > now) throw limited(until, now);
      if (
        row.generation !== attempt.generation ||
        row.current_attempt_id !== id ||
        !attempt.device_code
      )
        throw corrupt();
      const code = this.options.secrets.open(owner, id, 'device-code', attempt.device_code);
      const nonce = randomUUID();
      await client.query('UPDATE copilot_attempts SET lease_id=$2,lease_until=$3 WHERE id=$1', [
        id,
        nonce,
        new Date(now + 15000),
      ]);
      return { code, nonce, generation: row.generation, started: now };
    });
    if ('public' in claim && claim.public) return claim.public;
    if (!('code' in claim) || !claim.code) throw corrupt();
    let outcome: DeviceResult | undefined;
    let failure: CopilotError | undefined;
    try {
      outcome = await this.options.provider.poll(claim.code);
    } catch (error) {
      if (!(error instanceof CopilotError)) throw error;
      failure = error;
    }
    const result = await this.transaction(owner, async (client, row, now) => {
      const attempt = await this.find(client, owner, id);
      if (
        row.generation !== claim.generation ||
        attempt.lease_id !== claim.nonce ||
        !attempt.lease_until ||
        attempt.lease_until.getTime() <= now ||
        attempt.state !== 'pending'
      )
        return { attempt: this.publicAttempt(owner, attempt), stale: true };
      let event: CopilotEvent;
      if (failure) event = 'transport_error';
      else if (outcome?.type === 'approved') event = 'access_token';
      else if (outcome?.type === 'pending') event = 'authorization_pending';
      else if (outcome?.type === 'slow_down') event = 'slow_down';
      else if (outcome?.type === 'denied') event = 'access_denied';
      else if (outcome?.type === 'expired') event = 'expired_token';
      else if (outcome?.type === 'failed') event = 'provider_error';
      else throw corrupt();
      let interval = attempt.interval_seconds;
      if (outcome?.type === 'slow_down') interval = Math.max(interval + 5, outcome.interval ?? 0);
      const retries = failure ? attempt.retry_count + 1 : 0;
      const wait = Math.max(
        interval * 2 ** Math.min(retries, 20),
        outcome?.retryAfter ?? failure?.retryAfter ?? 0,
      );
      await this.transition(client, attempt, event);
      await client.query(
        'UPDATE copilot_attempts SET interval_seconds=$2,retry_count=$3,next_poll_at=$4 WHERE id=$1',
        [id, interval, retries, new Date(now + wait * 1000)],
      );
      attempt.next_poll_at = new Date(now + wait * 1000);
      if (outcome?.type === 'approved') {
        const record = randomUUID();
        await client.query(
          `UPDATE copilot_owners SET connection_id=$3,access_token=$4,token_expires_at=$5,reconnect_required=false
          WHERE tenant_id=$1 AND object_id=$2`,
          [
            owner.tenantId,
            owner.objectId,
            record,
            this.options.secrets.seal(owner, record, 'access-token', outcome.token),
            outcome.expiresIn ? new Date(claim.started + outcome.expiresIn * 1000) : null,
          ],
        );
      }
      return { attempt: this.publicAttempt(owner, attempt), stale: false };
    });
    if (failure && !result.stale) throw failure;
    return result.attempt;
  }
  async cancel(owner: Principal, id: string): Promise<CopilotAttempt> {
    return this.transaction(owner, async (client) => {
      const row = await this.find(client, owner, id);
      if (unfinished(row.state)) await this.transition(client, row, 'cancel');
      return this.publicAttempt(owner, row);
    });
  }
  async disconnect(owner: Principal): Promise<void> {
    await this.transaction(owner, async (client) => {
      await client.query(
        `UPDATE copilot_attempts SET state='cancelled',device_code=NULL,user_code=NULL,lease_id=NULL,lease_until=NULL
        WHERE tenant_id=$1 AND object_id=$2 AND state IN ('starting','pending')`,
        [owner.tenantId, owner.objectId],
      );
      await client.query(
        `UPDATE copilot_owners SET generation=$3,current_attempt_id=NULL,connection_id=NULL,
        access_token=NULL,token_expires_at=NULL,reconnect_required=false WHERE tenant_id=$1 AND object_id=$2`,
        [owner.tenantId, owner.objectId, randomUUID()],
      );
    });
  }
}
