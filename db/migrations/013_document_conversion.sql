CREATE TABLE document_conversion_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  project_id uuid NOT NULL,
  source_file_id uuid NOT NULL,
  source_name text NOT NULL,
  source_size bigint NOT NULL CHECK (source_size BETWEEN 0 AND 25000000),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_etag text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('automatic','manual')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','linked-to-job','failed-before-admission','cancelled-before-admission')),
  active boolean NOT NULL DEFAULT true,
  job_id uuid UNIQUE,
  reason text CHECK (reason IN ('handler_failed','interrupted','cancellation_unconfirmed','invalid_input','unsupported_type','input_too_large','page_limit','invalid_document','conversion_failed','timeout','runtime_unavailable','output_invalid','output_too_large','source_unavailable','source_changed','quota_exceeded')),
  markdown_id uuid,
  json_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,owner_oid,project_id,idempotency_key),
  FOREIGN KEY (project_id,tenant_id,owner_oid) REFERENCES projects(id,tenant_id,owner_oid) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((state='linked-to-job') = (job_id IS NOT NULL)),
  CHECK (state IN ('waiting','linked-to-job') OR NOT active),
  CHECK ((markdown_id IS NULL) = (json_id IS NULL)),
  CHECK (markdown_id IS NULL OR (state='linked-to-job' AND markdown_id<>json_id))
);
CREATE UNIQUE INDEX document_conversion_active_source
  ON document_conversion_requests(tenant_id,owner_oid,project_id,source_file_id) WHERE active;
CREATE UNIQUE INDEX document_conversion_automatic_source
  ON document_conversion_requests(tenant_id,owner_oid,project_id,source_file_id) WHERE origin='automatic';
CREATE INDEX document_conversion_waiting
  ON document_conversion_requests(created_at,id) WHERE state='waiting';
CREATE INDEX document_conversion_history
  ON document_conversion_requests(tenant_id,owner_oid,project_id,created_at DESC,id ASC);
