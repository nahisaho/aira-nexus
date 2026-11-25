CREATE TABLE copilot_owners (
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  generation uuid NOT NULL,
  current_attempt_id uuid,
  start_after timestamptz NOT NULL DEFAULT 'epoch',
  connection_id uuid,
  access_token text,
  token_expires_at timestamptz,
  reconnect_required boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, object_id),
  CHECK (access_token IS NULL OR connection_id IS NOT NULL)
);

CREATE TABLE copilot_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  generation uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('starting','pending','approved','denied','expired','cancelled','failed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  next_poll_at timestamptz NOT NULL,
  interval_seconds integer NOT NULL DEFAULT 5 CHECK (interval_seconds >= 5),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  lease_id uuid,
  lease_until timestamptz,
  device_code text,
  user_code text,
  FOREIGN KEY (tenant_id, object_id) REFERENCES copilot_owners(tenant_id, object_id),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL))
);
CREATE INDEX copilot_attempts_owner ON copilot_attempts(tenant_id, object_id);