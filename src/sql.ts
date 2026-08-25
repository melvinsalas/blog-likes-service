// SQL statements used by the blog API Worker. Keep values parameterized in index.ts
// with .bind(...) instead of interpolating user input into these strings.
export const SQL = {
	ensureContentStats: `INSERT OR IGNORE INTO content_stats (content_id)
		VALUES (?)`,

	selectContentStats: `SELECT content_id AS contentId, likes, visits
		FROM content_stats
		WHERE content_id = ?
		LIMIT 1`,

	selectAllContentStats: `SELECT content_id AS contentId, likes, visits
		FROM content_stats
		ORDER BY content_id`,

	deleteExpiredLikeDedupe: `DELETE FROM like_dedupe
		WHERE content_id = ?
		AND fingerprint = ?
		AND expires_at <= ?`,

	insertLikeDedupe: `INSERT OR IGNORE INTO like_dedupe (content_id, fingerprint, expires_at)
		VALUES (?, ?, ?)`,

	incrementLikesByClaim: `UPDATE content_stats
		SET likes = likes + changes()
		WHERE content_id = ?`,

	selectActiveLikeDedupe: `SELECT 1
		FROM like_dedupe
		WHERE content_id = ?
		AND fingerprint = ?
		AND expires_at > ?
		LIMIT 1`,

	deleteExpiredVisitDedupe: `DELETE FROM visit_dedupe
		WHERE content_id = ?
		AND fingerprint = ?
		AND expires_at <= ?`,

	insertVisitDedupe: `INSERT OR IGNORE INTO visit_dedupe (content_id, fingerprint, expires_at)
		VALUES (?, ?, ?)`,

	incrementVisitsByClaim: `UPDATE content_stats
		SET visits = visits + changes()
		WHERE content_id = ?`,

	selectActiveVisitDedupe: `SELECT 1
		FROM visit_dedupe
		WHERE content_id = ?
		AND fingerprint = ?
		AND expires_at > ?
		LIMIT 1`,
} as const;
