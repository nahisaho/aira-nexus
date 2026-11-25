ALTER TABLE chat_runs DROP CONSTRAINT chat_runs_snapshot_check;
ALTER TABLE chat_runs
  ADD CONSTRAINT chat_runs_snapshot_check CHECK (octet_length(snapshot) BETWEEN 1 AND 262144);

CREATE TABLE chat_model_catalogs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_generation uuid NOT NULL,
  models jsonb NOT NULL CHECK (jsonb_typeof(models) = 'array'),
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, owner_oid, project_id),
  FOREIGN KEY (project_id, tenant_id, owner_oid)
    REFERENCES projects(id, tenant_id, owner_oid) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE chat_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
  snapshot text NOT NULL CHECK (octet_length(snapshot) BETWEEN 1 AND 262144),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  project_version integer NOT NULL CHECK (project_version BETWEEN 0 AND 2147483647),
  history_revision integer NOT NULL CHECK (history_revision BETWEEN 0 AND 2147483647),
  connection_id uuid NOT NULL,
  connection_generation uuid NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  superseded_at timestamptz(3),
  consumed_at timestamptz(3),
  consumed_key text CHECK (consumed_key IS NULL OR consumed_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  consumed_run_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, tenant_id, owner_oid, project_id)
    REFERENCES chat_conversations(id, tenant_id, owner_oid, project_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (consumed_run_id, tenant_id, owner_oid, project_id)
    REFERENCES chat_runs(id, tenant_id, owner_oid, project_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((consumed_at IS NULL) = (consumed_key IS NULL)),
  CHECK ((consumed_at IS NULL) = (consumed_run_id IS NULL))
);

CREATE INDEX chat_previews_conversation
  ON chat_previews(tenant_id, owner_oid, project_id, conversation_id, created_at DESC);

ALTER TABLE chat_runs
  ADD COLUMN preview_id uuid REFERENCES chat_previews(id) ON DELETE RESTRICT;
