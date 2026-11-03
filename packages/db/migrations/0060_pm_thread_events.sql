-- Tenant-scoped, immutable PM intake and follow-up receipts.
ALTER TABLE pm_runs ADD COLUMN IF NOT EXISTS source_thread_id TEXT;

CREATE TABLE IF NOT EXISTS pm_thread_events (
  ordinal BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  thread_id TEXT NOT NULL CHECK (thread_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  run_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request','followup')),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  body JSONB NOT NULL CHECK (jsonb_typeof(body)='object' AND body->>'kind' IS NOT DISTINCT FROM kind),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, event_id),
  FOREIGN KEY (run_id, tenant_id, workspace_id) REFERENCES pm_runs(id, tenant_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_thread_events_timeline
  ON pm_thread_events (tenant_id, workspace_id, thread_id, ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_pm_thread_events_run
  ON pm_thread_events (tenant_id, workspace_id, run_id, kind, ordinal DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pm_thread_events_request_run
  ON pm_thread_events (tenant_id, workspace_id, run_id) WHERE kind='request';

ALTER TABLE pm_thread_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_thread_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_pm_thread_events_scope ON pm_thread_events;
CREATE POLICY p_pm_thread_events_scope ON pm_thread_events
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));

GRANT SELECT, INSERT ON pm_thread_events TO workloom_app;
REVOKE UPDATE, DELETE, TRUNCATE ON pm_thread_events FROM workloom_app;

CREATE INDEX IF NOT EXISTS idx_pm_runs_active_thread
  ON pm_runs (tenant_id, workspace_id, source_thread_id, created_at DESC, id DESC)
  WHERE source_thread_id IS NOT NULL AND status NOT IN ('completed','cancelled');

CREATE OR REPLACE FUNCTION pm_thread_event_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PM thread events are append-only';
END;
$$;
DROP TRIGGER IF EXISTS trg_pm_thread_event_immutable ON pm_thread_events;
CREATE TRIGGER trg_pm_thread_event_immutable BEFORE UPDATE OR DELETE ON pm_thread_events
  FOR EACH ROW EXECUTE FUNCTION pm_thread_event_immutable();
