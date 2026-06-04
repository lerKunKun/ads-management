-- =============================================
-- 应用专用非超级用户 ads_app (受 RLS 约束)
-- 迁移/seed 用 ads (superuser, bypass RLS)
-- =============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ads_app') THEN
    CREATE ROLE ads_app NOSUPERUSER NOINHERIT LOGIN PASSWORD 'ads_app';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO ads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ads_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ads_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ads_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ads_app;

-- =============================================
-- Row-Level Security 策略
-- 思路:
--   1) 每个连接/事务通过 SET LOCAL app.current_company_id = '<uuid>' 注入租户上下文。
--   2) 业务表的策略: company_id = current_company_id;  或 bypass='1'(PlatformAdmin / 后台任务)。
--   3) permissions 是全局字典，不开 RLS。
--   4) roles.company_id 可为 NULL(平台级)，对 PlatformAdmin / Company 都可见。
-- =============================================

-- 帮助函数：读上下文
CREATE OR REPLACE FUNCTION app_current_company() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_company_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.bypass_rls', true) = '1'
$$;

-- ---------- companies ----------
ALTER TABLE companies ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_companies_select ON companies;
CREATE POLICY p_companies_select ON companies
  FOR SELECT USING (app_bypass_rls() OR id = app_current_company());
DROP POLICY IF EXISTS p_companies_mod ON companies;
CREATE POLICY p_companies_mod ON companies
  FOR ALL USING (app_bypass_rls() OR id = app_current_company())
            WITH CHECK (app_bypass_rls() OR id = app_current_company());

-- ---------- users ----------
ALTER TABLE users ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_users_all ON users;
CREATE POLICY p_users_all ON users
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

-- ---------- roles ----------
-- 平台级 (company_id IS NULL) 对所有人可读
ALTER TABLE roles ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_roles_select ON roles;
CREATE POLICY p_roles_select ON roles
  FOR SELECT USING (app_bypass_rls() OR company_id IS NULL OR company_id = app_current_company());
DROP POLICY IF EXISTS p_roles_mod ON roles;
CREATE POLICY p_roles_mod ON roles
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

-- ---------- role_permissions / user_roles (no company_id, 由父表 + bypass 控)
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_role_permissions_all ON role_permissions;
CREATE POLICY p_role_permissions_all ON role_permissions
  FOR ALL USING (
    app_bypass_rls() OR EXISTS (
      SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id
        AND (r.company_id IS NULL OR r.company_id = app_current_company())
    )
  ) WITH CHECK (
    app_bypass_rls() OR EXISTS (
      SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id
        AND (r.company_id IS NULL OR r.company_id = app_current_company())
    )
  );

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_user_roles_all ON user_roles;
CREATE POLICY p_user_roles_all ON user_roles
  FOR ALL USING (
    app_bypass_rls() OR EXISTS (
      SELECT 1 FROM users u WHERE u.id = user_roles.user_id AND u.company_id = app_current_company()
    )
  ) WITH CHECK (
    app_bypass_rls() OR EXISTS (
      SELECT 1 FROM users u WHERE u.id = user_roles.user_id AND u.company_id = app_current_company()
    )
  );

-- ---------- user_resource_grants ----------
ALTER TABLE user_resource_grants ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_grants_all ON user_resource_grants;
CREATE POLICY p_grants_all ON user_resource_grants
  FOR ALL USING (
    app_bypass_rls() OR EXISTS (
      SELECT 1 FROM users u WHERE u.id = user_resource_grants.user_id AND u.company_id = app_current_company()
    )
  ) WITH CHECK (
    app_bypass_rls() OR EXISTS (
      SELECT 1 FROM users u WHERE u.id = user_resource_grants.user_id AND u.company_id = app_current_company()
    )
  );

-- ---------- permission_approval_requests ----------
ALTER TABLE permission_approval_requests ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_permission_approval_requests_all ON permission_approval_requests;
CREATE POLICY p_permission_approval_requests_all ON permission_approval_requests
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

-- ---------- fb_accounts ----------
ALTER TABLE fb_accounts ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_fb_all ON fb_accounts;
CREATE POLICY p_fb_all ON fb_accounts
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

-- ---------- ad_accounts ----------
ALTER TABLE ad_accounts ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_ad_all ON ad_accounts;
CREATE POLICY p_ad_all ON ad_accounts
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

-- ---------- operation_tasks / items ----------
ALTER TABLE operation_tasks ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_op_tasks_all ON operation_tasks;
CREATE POLICY p_op_tasks_all ON operation_tasks
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

ALTER TABLE operation_task_items ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_op_items_all ON operation_task_items;
CREATE POLICY p_op_items_all ON operation_task_items
  FOR ALL USING (
    app_bypass_rls() OR EXISTS (
      SELECT 1 FROM operation_tasks t WHERE t.id = operation_task_items.task_id
        AND t.company_id = app_current_company()
    )
  ) WITH CHECK (
    app_bypass_rls() OR EXISTS (
      SELECT 1 FROM operation_tasks t WHERE t.id = operation_task_items.task_id
        AND t.company_id = app_current_company()
    )
  );

ALTER TABLE operation_copy_workflows ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_op_copy_workflows_all ON operation_copy_workflows;
CREATE POLICY p_op_copy_workflows_all ON operation_copy_workflows
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

ALTER TABLE operation_copy_steps ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_op_copy_steps_all ON operation_copy_steps;
CREATE POLICY p_op_copy_steps_all ON operation_copy_steps
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

-- ---------- local ad objects ----------
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_campaigns_all ON campaigns;
CREATE POLICY p_campaigns_all ON campaigns
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

ALTER TABLE adsets ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_adsets_all ON adsets;
CREATE POLICY p_adsets_all ON adsets
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

ALTER TABLE ads ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_ads_all ON ads;
CREATE POLICY p_ads_all ON ads
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

ALTER TABLE archived_ads ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_archived_ads_all ON archived_ads;
CREATE POLICY p_archived_ads_all ON archived_ads
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

ALTER TABLE ad_account_sync_state ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_ad_sync_state_all ON ad_account_sync_state;
CREATE POLICY p_ad_sync_state_all ON ad_account_sync_state
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

-- ---------- audit_logs ----------
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_audit_all ON audit_logs;
CREATE POLICY p_audit_all ON audit_logs
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());

-- ---------- release announcements ----------
ALTER TABLE release_announcements ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_release_announcements_select ON release_announcements;
CREATE POLICY p_release_announcements_select ON release_announcements
  FOR SELECT USING (app_bypass_rls() OR status = 'published');
DROP POLICY IF EXISTS p_release_announcements_mod ON release_announcements;
CREATE POLICY p_release_announcements_mod ON release_announcements
  FOR ALL USING (app_bypass_rls())
            WITH CHECK (app_bypass_rls());

ALTER TABLE release_announcement_reads ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_release_announcement_reads_all ON release_announcement_reads;
CREATE POLICY p_release_announcement_reads_all ON release_announcement_reads
  FOR ALL USING (app_bypass_rls())
            WITH CHECK (app_bypass_rls());
