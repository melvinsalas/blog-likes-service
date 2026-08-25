-- Move from "one row per like" to permanent counters plus temporary
-- deduplication rows.
--
-- The old likes table is preserved as legacy_likes for audit/rollback
-- reference. The Worker no longer reads from it after this migration.
ALTER TABLE likes RENAME TO legacy_likes;

-- Permanent public counters. Runtime reads must use this table, never COUNT(*)
-- over fingerprint/dedupe rows.
CREATE TABLE IF NOT EXISTS content_stats (
	content_id TEXT PRIMARY KEY,
	likes INTEGER NOT NULL DEFAULT 0,
	visits INTEGER NOT NULL DEFAULT 0
);

-- Temporary like dedupe rows. They prevent repeated likes while active, but
-- deleting expired rows must never decrement content_stats.likes.
CREATE TABLE IF NOT EXISTS like_dedupe (
	content_id TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (content_id, fingerprint)
);

-- Temporary visit dedupe rows. Visits currently use a 24-hour logical window
-- in the Worker.
CREATE TABLE IF NOT EXISTS visit_dedupe (
	content_id TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (content_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_like_dedupe_expires_at
ON like_dedupe(expires_at);

CREATE INDEX IF NOT EXISTS idx_visit_dedupe_expires_at
ON visit_dedupe(expires_at);

-- One-time backfill from legacy rows into the permanent likes counter.
-- COUNT(*) is valid here because this is migration logic only; runtime API
-- reads use content_stats.likes.
INSERT INTO content_stats (content_id, likes, visits)
SELECT post_id, COUNT(*), 0
FROM legacy_likes
GROUP BY post_id
ON CONFLICT(content_id) DO UPDATE SET
	likes = content_stats.likes + excluded.likes;

-- Preserve existing like dedupe behavior for visitors who already liked content
-- before this migration. Seeded dedupe rows expire at the start of the next UTC
-- year, matching the Worker's yearly fingerprint rotation.
INSERT OR IGNORE INTO like_dedupe (content_id, fingerprint, expires_at)
SELECT
	post_id,
	visitor_hash,
	unixepoch(printf('%04d-01-01 00:00:00', CAST(strftime('%Y', 'now') AS INTEGER) + 1))
FROM legacy_likes;
