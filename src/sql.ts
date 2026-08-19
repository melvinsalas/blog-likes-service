// SQL statements used by the likes Worker. Keep values parameterized in index.ts
// with .bind(...) instead of interpolating user input into these strings.
export const SQL = {
	insertLike: `INSERT OR IGNORE INTO likes (post_id, visitor_hash, created_at)
		VALUES (?, ?, ?)`,

	selectExistingLike: `SELECT 1
		FROM likes
		WHERE post_id = ?
		AND visitor_hash = ?
		LIMIT 1`,

	countLikes: `SELECT COUNT(*) AS count
		FROM likes
		WHERE post_id = ?`,
} as const;
