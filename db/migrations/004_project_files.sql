CREATE TABLE project_files (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255 AND name=btrim(name) AND name !~ '[/\\[:cntrl:]]'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 100000000),
  kind text NOT NULL CHECK (kind IN ('text','png','svg','pdf','download')),
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','ready','failed')),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '15 minutes'),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  etag text CHECK (length(etag) BETWEEN 1 AND 1024),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='ready' AND sha256 IS NOT NULL AND etag IS NOT NULL)
    OR (state<>'ready' AND sha256 IS NULL AND etag IS NULL))
);
CREATE INDEX project_files_ready ON project_files(project_id,created_at DESC,id ASC) WHERE state='ready';
CREATE INDEX project_files_uploading ON project_files(project_id,expires_at) WHERE state='uploading';
