-- Speed up local first-page reads for the campaign/adset/ad list views.
-- Run outside a transaction because these indexes are created concurrently.

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_company_account_created_idx
  ON campaigns (company_id, ad_account_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_company_account_status_created_idx
  ON campaigns (company_id, ad_account_id, status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS adsets_company_account_campaign_created_idx
  ON adsets (company_id, ad_account_id, campaign_meta_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ads_company_account_adset_created_idx
  ON ads (company_id, ad_account_id, adset_meta_id, created_at DESC);
