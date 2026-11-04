-- Retain definite no-send history without displacing older or uncertain evidence.
ALTER TABLE pm_superagent_search
  ADD COLUMN attempt_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN blocked_before_send_at TIMESTAMPTZ,
  ADD CONSTRAINT pm_superagent_search_no_send CHECK (blocked_before_send_at IS NULL OR completed_at IS NULL),
  DROP CONSTRAINT pm_superagent_search_pkey,
  ADD PRIMARY KEY (run_id, tenant_id, workspace_id, attempt_id);

-- Existing rows remain active and keep their original evidence or pending status.
CREATE UNIQUE INDEX pm_superagent_search_active_run ON pm_superagent_search (run_id, tenant_id, workspace_id)
  WHERE blocked_before_send_at IS NULL;
GRANT UPDATE (blocked_before_send_at) ON pm_superagent_search TO workloom_app;
CREATE POLICY p_pm_superagent_search_settle_pending ON pm_superagent_search AS RESTRICTIVE FOR UPDATE TO workloom_app
  USING (completed_at IS NULL AND blocked_before_send_at IS NULL) WITH CHECK (true);
