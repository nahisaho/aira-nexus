ALTER TABLE projects ADD CONSTRAINT projects_job_owner UNIQUE (id, tenant_id, owner_oid);
CREATE TABLE durable_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  project_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 64),
  input jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','cancel_requested','succeeded','failed','cancelled')),
  fence uuid,
  lease_until timestamptz(3),
  cancel_deadline timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz(3),
  finished_at timestamptz(3),
  cancel_requested_at timestamptz(3),
  failure_code text CHECK (failure_code IN ('handler_failed','interrupted','cancellation_unconfirmed','invalid_input')),
  UNIQUE (tenant_id, owner_oid, project_id, idempotency_key),
  FOREIGN KEY (project_id, tenant_id, owner_oid) REFERENCES projects(id, tenant_id, owner_oid) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((state IN ('running','cancel_requested')) = (fence IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (state NOT IN ('running','cancel_requested') OR started_at IS NOT NULL),
  CHECK ((state IN ('succeeded','failed','cancelled')) = (finished_at IS NOT NULL)),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CHECK (state <> 'cancel_requested' OR (cancel_requested_at IS NOT NULL AND cancel_deadline IS NOT NULL))
);
CREATE INDEX durable_jobs_history ON durable_jobs(tenant_id, owner_oid, project_id, created_at DESC, id ASC);
CREATE INDEX durable_jobs_queue ON durable_jobs(created_at, id) WHERE state = 'queued';
CREATE INDEX durable_jobs_active ON durable_jobs(tenant_id, owner_oid, project_id) WHERE state IN ('queued','running','cancel_requested');
