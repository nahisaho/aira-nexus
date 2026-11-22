ALTER TABLE durable_jobs
  ADD CONSTRAINT durable_jobs_chat_owner UNIQUE (id, tenant_id, owner_oid, project_id);

CREATE TABLE chat_conversations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  project_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  history_revision integer NOT NULL DEFAULT 0 CHECK (history_revision BETWEEN 0 AND 2147483647),
  preview text NOT NULL DEFAULT '',
  latest_run_id uuid,
  active_run_id uuid,
  UNIQUE (id, tenant_id, owner_oid, project_id),
  FOREIGN KEY (project_id, tenant_id, owner_oid)
    REFERENCES projects(id, tenant_id, owner_oid) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE chat_runs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
  snapshot text NOT NULL CHECK (octet_length(snapshot) BETWEEN 1 AND 16384),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  assistant_turn_sequence integer NOT NULL CHECK (assistant_turn_sequence BETWEEN 1 AND 2147483647),
  state text NOT NULL CHECK (state IN ('queued','running','cancel_requested','succeeded','failed','cancelled')),
  answer text NOT NULL DEFAULT '',
  failure_code text CHECK (failure_code IN ('handler_failed','interrupted','cancellation_unconfirmed','invalid_input')),
  last_sequence integer NOT NULL DEFAULT 0 CHECK (last_sequence BETWEEN 0 AND 2147483647),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, owner_oid, project_id, conversation_id, idempotency_key),
  UNIQUE (id, tenant_id, owner_oid, project_id),
  FOREIGN KEY (conversation_id, tenant_id, owner_oid, project_id)
    REFERENCES chat_conversations(id, tenant_id, owner_oid, project_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (job_id, tenant_id, owner_oid, project_id)
    REFERENCES durable_jobs(id, tenant_id, owner_oid, project_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);

CREATE INDEX chat_runs_owner_state
  ON chat_runs(tenant_id, owner_oid, created_at DESC, id ASC)
  WHERE state IN ('queued','running','cancel_requested');
CREATE INDEX chat_runs_conversation
  ON chat_runs(conversation_id, created_at DESC, id ASC);

CREATE TABLE chat_turns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 2147483647),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  text text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, sequence),
  FOREIGN KEY (conversation_id, tenant_id, owner_oid, project_id)
    REFERENCES chat_conversations(id, tenant_id, owner_oid, project_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX chat_turns_history
  ON chat_turns(conversation_id, sequence ASC);

CREATE TABLE chat_events (
  run_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  project_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 2147483647),
  event_key text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 128),
  type text NOT NULL CHECK (type IN ('delta','status')),
  text text NOT NULL DEFAULT '',
  state text CHECK (state IN ('queued','running','cancel_requested','succeeded','failed','cancelled')),
  reason text CHECK (reason IN ('handler_failed','interrupted','cancellation_unconfirmed','invalid_input')),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, sequence),
  UNIQUE (run_id, event_key),
  FOREIGN KEY (run_id, tenant_id, owner_oid, project_id)
    REFERENCES chat_runs(id, tenant_id, owner_oid, project_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((type = 'status') = (state IS NOT NULL)),
  CHECK (type <> 'delta' OR (state IS NULL AND reason IS NULL)),
  CHECK (reason IS NULL OR state = 'failed')
);