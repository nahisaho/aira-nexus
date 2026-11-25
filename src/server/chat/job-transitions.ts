import type { PoolClient } from 'pg';
import type { ChatFailureCode, ChatRunState } from '../../shared/chat.js';

interface ChatJobOwner {
  id: string;
  tenant_id: string;
  owner_oid: string;
  project_id: string;
}

interface ChatRunRow {
  id: string;
  conversation_id: string;
  state: ChatRunState;
  last_sequence: number;
}

const terminal = new Set<ChatRunState>(['succeeded', 'failed', 'cancelled']);

export async function syncChatJobTransition(
  client: PoolClient,
  job: ChatJobOwner,
  state: ChatRunState,
  failureCode: ChatFailureCode | null,
): Promise<void> {
  const project = await client.query(
    'SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND owner_oid=$3 FOR UPDATE',
    [job.project_id, job.tenant_id, job.owner_oid],
  );
  if (!project.rowCount) throw new Error('Chat job project is missing.');

  const run = (
    await client.query<ChatRunRow>(
      `SELECT id,conversation_id,state,last_sequence FROM chat_runs
       WHERE job_id=$1 AND tenant_id=$2 AND owner_oid=$3 AND project_id=$4 FOR UPDATE`,
      [job.id, job.tenant_id, job.owner_oid, job.project_id],
    )
  ).rows[0];
  if (!run) throw new Error('Chat job run is missing.');
  if (run.state === state) return;

  const sequence =
    terminal.has(state) || state === 'cancel_requested' ? run.last_sequence + 1 : run.last_sequence;
  if (sequence > 2147483647) throw new Error('Chat event sequence exhausted.');

  if (sequence > run.last_sequence) {
    await client.query(
      `INSERT INTO chat_events(run_id,tenant_id,owner_oid,project_id,sequence,event_key,type,state,reason)
       VALUES($1,$2,$3,$4,$5,$6,'status',$7,$8)`,
      [
        run.id,
        job.tenant_id,
        job.owner_oid,
        job.project_id,
        sequence,
        `status:${sequence}`,
        state,
        failureCode,
      ],
    );
  }
  const updated = await client.query(
    `UPDATE chat_runs SET state=$2,failure_code=$3,last_sequence=$4,updated_at=clock_timestamp()
     WHERE id=$1 AND state<>$2`,
    [run.id, state, failureCode, sequence],
  );
  if (!updated.rowCount) return;
  const conversation = await client.query(
    `UPDATE chat_conversations SET
       history_revision=history_revision+1,updated_at=clock_timestamp(),
       active_run_id=CASE WHEN $2 THEN NULL ELSE active_run_id END
     WHERE id=$1 AND tenant_id=$3 AND owner_oid=$4 AND project_id=$5`,
    [run.conversation_id, terminal.has(state), job.tenant_id, job.owner_oid, job.project_id],
  );
  if (!conversation.rowCount) throw new Error('Chat run conversation is missing.');
}
