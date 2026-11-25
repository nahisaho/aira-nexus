ALTER TABLE project_files ADD COLUMN purge_pending boolean NOT NULL DEFAULT false;
ALTER TABLE project_files ADD CONSTRAINT project_files_purge_trashed CHECK (NOT purge_pending OR (state='ready' AND trashed_at IS NOT NULL));
CREATE INDEX project_files_purge ON project_files(project_id,id) WHERE purge_pending;
