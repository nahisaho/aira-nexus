CREATE TABLE notebook_cells (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  project_id uuid NOT NULL,
  language text NOT NULL CHECK (language IN ('python', 'r')),
  code text NOT NULL CHECK (octet_length(code) <= 262144),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  output text NOT NULL DEFAULT '' CHECK (octet_length(output) <= 8388608),
  executed_by uuid,
  state_lost boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, tenant_id, owner_oid)
    REFERENCES projects(id, tenant_id, owner_oid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX notebook_cells_project ON notebook_cells(project_id, created_at, id);

CREATE TABLE notebook_kernels (
  project_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  language text NOT NULL CHECK (language IN ('python', 'r')),
  generation uuid NOT NULL UNIQUE,
  token text NOT NULL CHECK (length(token) = 64),
  inputs_hash text NOT NULL CHECK (length(inputs_hash) = 64),
  state text NOT NULL CHECK (state IN ('idle', 'executing')),
  last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, language),
  FOREIGN KEY (project_id, tenant_id, owner_oid)
    REFERENCES projects(id, tenant_id, owner_oid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
