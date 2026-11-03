-- A requested public search has one durable reservation per scoped PM run.
CREATE TABLE pm_superagent_search (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  query_sha256 TEXT NOT NULL CHECK (query_sha256 ~ '^[a-f0-9]{64}$'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  evidence JSONB,
  PRIMARY KEY (run_id, tenant_id, workspace_id),
  FOREIGN KEY (run_id, tenant_id, workspace_id) REFERENCES pm_runs (id, tenant_id, workspace_id),
  CHECK ((completed_at IS NULL) = (evidence IS NULL)),
  CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object')
);
ALTER TABLE pm_superagent_search ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_superagent_search FORCE ROW LEVEL SECURITY;
CREATE POLICY p_pm_superagent_search_scope ON pm_superagent_search
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT, INSERT ON pm_superagent_search TO workloom_app;
GRANT UPDATE (completed_at, evidence) ON pm_superagent_search TO workloom_app;
