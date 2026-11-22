ALTER TABLE project_files ADD COLUMN trashed_at timestamptz;
ALTER TABLE project_files ADD CONSTRAINT project_files_trash_ready CHECK (trashed_at IS NULL OR state='ready');
CREATE INDEX project_files_trash ON project_files(project_id,created_at DESC,id ASC) WHERE state='ready' AND trashed_at IS NOT NULL;
