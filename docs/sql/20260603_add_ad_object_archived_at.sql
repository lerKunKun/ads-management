-- Add local archive markers for ad object list display.
-- Safe to run on preview or production; it only adds nullable columns/indexes
-- and backfills existing ARCHIVED/DELETED rows.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS campaigns_account_archived_idx
  ON campaigns (ad_account_id, archived_at);
CREATE INDEX IF NOT EXISTS adsets_account_archived_idx
  ON adsets (ad_account_id, archived_at);
CREATE INDEX IF NOT EXISTS ads_account_archived_idx
  ON ads (ad_account_id, archived_at);

UPDATE campaigns
SET archived_at = COALESCE(meta_updated_time, last_synced_at, updated_at, now())
WHERE archived_at IS NULL
  AND (
    status IN ('ARCHIVED', 'DELETED')
    OR effective_status IN ('ARCHIVED', 'DELETED')
  );

UPDATE adsets
SET archived_at = COALESCE(meta_updated_time, last_synced_at, updated_at, now())
WHERE archived_at IS NULL
  AND (
    status IN ('ARCHIVED', 'DELETED')
    OR effective_status IN ('ARCHIVED', 'DELETED')
  );

UPDATE ads
SET archived_at = COALESCE(meta_updated_time, last_synced_at, updated_at, now())
WHERE archived_at IS NULL
  AND (
    status IN ('ARCHIVED', 'DELETED')
    OR effective_status IN ('ARCHIVED', 'DELETED')
  );
