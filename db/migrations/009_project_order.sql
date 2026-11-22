CREATE TABLE project_order_states (
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  pinned uuid[] NOT NULL DEFAULT '{}',
  recent uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, owner_oid)
);
