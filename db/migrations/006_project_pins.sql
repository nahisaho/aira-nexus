CREATE TABLE project_pins (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  pinned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
