ALTER TABLE projects
  ADD COLUMN description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  ADD COLUMN trashed_at timestamptz(3);
CREATE INDEX projects_owner_trash ON projects(tenant_id, owner_oid, updated_at DESC, id ASC)
  WHERE trashed_at IS NOT NULL;
