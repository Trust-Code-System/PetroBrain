-- Oil-and-gas compliance tasks, scheduled research digests, and admin alerts.

CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    created_by_user_id TEXT NOT NULL,
    created_by_user_name TEXT,
    assigned_to_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    assigned_to_team TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL,
    recurrence_type TEXT NOT NULL,
    recurrence_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
    start_date TIMESTAMPTZ,
    due_date TIMESTAMPTZ,
    timezone TEXT NOT NULL,
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    reminder_channels JSONB NOT NULL DEFAULT '["in_app"]'::jsonb,
    related_module TEXT,
    related_asset_id TEXT,
    related_project_id TEXT,
    related_document_id TEXT,
    safety_critical BOOLEAN NOT NULL DEFAULT false,
    compliance_critical BOOLEAN NOT NULL DEFAULT false,
    digest_config JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_due ON tasks (tenant_id, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks (tenant_id, status);

CREATE TABLE IF NOT EXISTS scheduled_digests (
    digest_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    created_by_user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    topics JSONB NOT NULL DEFAULT '[]'::jsonb,
    sources_allowed JSONB NOT NULL DEFAULT '[]'::jsonb,
    domains_allowed JSONB NOT NULL DEFAULT '[]'::jsonb,
    recurrence_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
    next_run_at TIMESTAMPTZ,
    output_format TEXT NOT NULL DEFAULT 'research_draft',
    recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'active',
    last_run_summary TEXT,
    task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_notifications (
    notification_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id TEXT,
    user_name TEXT,
    user_role TEXT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unread',
    related_audit_id TEXT,
    related_conversation_id TEXT,
    related_task_id TEXT,
    related_module TEXT,
    triggered_rule TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_by TEXT,
    acknowledged_at TIMESTAMPTZ,
    resolved_by TEXT,
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_status
    ON admin_notifications (tenant_id, status, created_at DESC);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['tasks', 'scheduled_digests', 'admin_notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I FOR ALL USING '
      '(current_setting(''petrobrain.tenant_id'') = ''*'' OR '
      ' current_setting(''petrobrain.tenant_id'') = tenant_id) WITH CHECK '
      '(current_setting(''petrobrain.tenant_id'') = ''*'' OR '
      ' current_setting(''petrobrain.tenant_id'') = tenant_id)',
      table_name, table_name
    );
  END LOOP;
END $$;
