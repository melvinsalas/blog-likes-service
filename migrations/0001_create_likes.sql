CREATE TABLE IF NOT EXISTS likes (
	post_id TEXT NOT NULL,
	visitor_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (post_id, visitor_hash)
);
