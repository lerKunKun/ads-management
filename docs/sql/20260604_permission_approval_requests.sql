DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'permission_approval_status') THEN
    CREATE TYPE permission_approval_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS permission_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fb_account_id uuid NOT NULL REFERENCES fb_accounts(id) ON DELETE CASCADE,
  requested_ad_account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_ad_account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status permission_approval_status NOT NULL DEFAULT 'pending',
  note text,
  review_note text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS permission_approval_company_status_created_idx
  ON permission_approval_requests(company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS permission_approval_requester_created_idx
  ON permission_approval_requests(requester_id, created_at DESC);

CREATE INDEX IF NOT EXISTS permission_approval_fb_account_created_idx
  ON permission_approval_requests(fb_account_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON permission_approval_requests TO ads_app;

ALTER TABLE permission_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_approval_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_permission_approval_requests_all ON permission_approval_requests;
CREATE POLICY p_permission_approval_requests_all ON permission_approval_requests
  FOR ALL USING (app_bypass_rls() OR company_id = app_current_company())
            WITH CHECK (app_bypass_rls() OR company_id = app_current_company());
