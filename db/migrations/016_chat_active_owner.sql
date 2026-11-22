CREATE UNIQUE INDEX chat_runs_one_active_owner
  ON chat_runs(tenant_id, owner_oid)
  WHERE state IN ('queued', 'running', 'cancel_requested');
