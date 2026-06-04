ALTER TABLE release_announcements
  ADD COLUMN IF NOT EXISTS is_pinned boolean DEFAULT false NOT NULL;

CREATE INDEX IF NOT EXISTS release_announcements_pinned_published_idx
  ON release_announcements (is_pinned, status, published_at);

CREATE UNIQUE INDEX IF NOT EXISTS release_announcements_single_pinned_idx
  ON release_announcements (is_pinned)
  WHERE is_pinned = true AND status = 'published';
