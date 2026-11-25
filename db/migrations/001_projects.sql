CREATE TABLE projects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_oid uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX projects_owner_updated ON projects(tenant_id, owner_oid, updated_at DESC, id ASC);
