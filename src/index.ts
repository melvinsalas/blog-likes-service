import { SQL } from './sql';
import { submitComment, type CommentsEnv } from './comments';

type AppEnv = Env & CommentsEnv & {
	// ALLOWED_ORIGINS is configured outside wrangler.jsonc so deployments can
	// keep Dashboard-managed variables.
	ALLOWED_ORIGINS?: string;
	// SECRET_SALT is a Wrangler secret. It is optional here so the Worker can
	// return a clear error if it is missing locally or in production.
	SECRET_SALT?: string;
};

// Normalize paths into simple contentId values to avoid ambiguous routes or odd input.
const POST_ID_PATTERN = /^[a-z0-9](?:[a-z0-9:-]{0,118}[a-z0-9])?$/;
const LIKE_API_ROUTE_PATTERN = /^\/api\/like\/(.+)$/;
const STATS_API_ROUTE_PATTERN = /^\/api\/stats\/(.+)$/;
const COMMENTS_API_ROUTE_PATTERN = /^\/api\/comments\/(.+)$/;
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const VISIT_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

export default {
	async fetch(request, env) {
		const allowedOrigins = getAllowedOrigins(env);

		try {
			if (!isAllowedOrigin(request, allowedOrigins)) {
				return jsonResponse(request, allowedOrigins, { error: 'Origin not allowed' }, 403);
			}

			// Answer CORS preflight without touching D1.
			if (request.method === 'OPTIONS') {
				return new Response(null, { status: 204, headers: getCorsHeaders(request, allowedOrigins) });
			}

			const url = new URL(request.url);
			const commentContentId = getContentId(url, COMMENTS_API_ROUTE_PATTERN);

			if (commentContentId) {
				if (request.method !== 'POST') {
					return jsonResponse(request, allowedOrigins, { error: 'Method not allowed' }, 405, {
						Allow: 'POST, OPTIONS',
					});
				}

				const result = await submitComment(request, env, commentContentId);
				return jsonResponse(request, allowedOrigins, result.body, result.status);
			}

			if (url.pathname === '/api/stats/' || url.pathname === '/api/stats') {
				if (request.method !== 'GET') {
					return jsonResponse(request, allowedOrigins, { error: 'Method not allowed' }, 405, {
						Allow: 'GET, OPTIONS',
					});
				}

				return jsonResponse(request, allowedOrigins, { stats: await getAllStats(env.DB) });
			}

			const contentId =
				getContentId(url, LIKE_API_ROUTE_PATTERN) ??
				getContentId(url, STATS_API_ROUTE_PATTERN);

			if (!contentId) {
				return jsonResponse(request, allowedOrigins, { error: 'Not found' }, 404);
			}

			// Without the salt, the Worker cannot create a stable private hash.
			if (!env.SECRET_SALT) {
				return jsonResponse(request, allowedOrigins, { error: 'Service not configured' }, 500);
			}

			const visitorHash = await getVisitorHash(request, env.SECRET_SALT);

			if (!visitorHash) {
				return jsonResponse(request, allowedOrigins, { error: 'Visitor address unavailable' }, 400);
			}

			const now = Math.floor(Date.now() / 1000);
			const routeType = getRouteType(url);

			if (routeType === 'stats') {
				if (request.method !== 'GET') {
					return jsonResponse(request, allowedOrigins, { error: 'Method not allowed' }, 405, {
						Allow: 'GET, OPTIONS',
					});
				}

				const [liked, stats] = await Promise.all([
					hasActiveDedupe(env.DB, 'like', contentId, visitorHash, now),
					recordInteraction(
						env.DB,
						'visit',
						contentId,
						visitorHash,
						now,
						now + VISIT_DEDUPE_TTL_SECONDS,
					),
				]);

				return jsonResponse(request, allowedOrigins, {
					contentId,
					likes: stats.likes,
					visits: stats.visits,
					liked,
				});
			}

			if (routeType === 'like') {
				if (request.method === 'POST') {
					const stats = await recordInteraction(env.DB, 'like', contentId, visitorHash, now, getLikeExpiresAt());

					return jsonResponse(request, allowedOrigins, {
						contentId,
						likes: stats.likes,
						visits: stats.visits,
						liked: true,
					});
				}
			}

			return jsonResponse(request, allowedOrigins, { error: 'Method not allowed' }, 405, {
				Allow: ALLOWED_METHODS,
			});
		} catch (error) {
			// The blog can ignore a 500: this Worker must never be required to
			// render the static post.
			console.error(JSON.stringify({ message: 'likes_request_failed', error: getErrorMessage(error) }));

			return jsonResponse(request, allowedOrigins, { error: 'Internal error' }, 500);
		}
	},
} satisfies ExportedHandler<AppEnv>;

function getContentId(url: URL, routePattern: RegExp) {
	const rawPostId = url.pathname.match(routePattern)?.[1]?.replace(/\/+$/, '');

	if (!rawPostId) return undefined;

	let decodedPostId: string;

	try {
		decodedPostId = decodeURIComponent(rawPostId);
	} catch {
		return undefined;
	}

	const postId = decodedPostId
		.toLowerCase()
		.replace(/^\/+|\/+$/g, '')
		.replaceAll('/', '-');

	return POST_ID_PATTERN.test(postId) ? postId : undefined;
}

function getRouteType(url: URL) {
	if (LIKE_API_ROUTE_PATTERN.test(url.pathname)) return 'like';
	if (STATS_API_ROUTE_PATTERN.test(url.pathname)) return 'stats';

	return undefined;
}

function getAllowedOrigins(env: AppEnv) {
	return (env.ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
}

// Allows requests with no Origin, such as curl or local Wrangler requests, and
// requires the allowlist when the request comes from a browser.
function isAllowedOrigin(request: Request, allowedOrigins: string[]) {
	const origin = request.headers.get('Origin');

	return !origin || allowedOrigins.includes(origin);
}

function getCorsHeaders(request: Request, allowedOrigins: string[]) {
	const headers = new Headers({
		'Access-Control-Allow-Methods': ALLOWED_METHODS,
		'Access-Control-Allow-Headers': 'Accept, Content-Type',
		Vary: 'Origin',
	});
	const origin = request.headers.get('Origin');

	if (origin && allowedOrigins.includes(origin)) {
		headers.set('Access-Control-Allow-Origin', origin);
	}

	return headers;
}

function jsonResponse(
	request: Request,
	allowedOrigins: string[],
	body: unknown,
	status = 200,
	extraHeaders: HeadersInit = {},
) {
	const headers = getCorsHeaders(request, allowedOrigins);
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');
	headers.set('X-Robots-Tag', 'noindex, nofollow');

	new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));

	return new Response(JSON.stringify(body), { status, headers });
}

// Gets the real IP that Cloudflare injects into the request. Local development
// uses 127.0.0.1 so the flow can be tested without Cloudflare in front.
function getVisitorIp(request: Request) {
	const cloudflareIp = request.headers.get('CF-Connecting-IP')?.trim();

	if (cloudflareIp) return cloudflareIp;

	const hostname = new URL(request.url).hostname;

	if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return '127.0.0.1';

	return undefined;
}

// Creates the private visitor identifier: IP + UTC year + SECRET_SALT, hashed
// with SHA-256. It changes every year and never stores the IP in D1.
async function getVisitorHash(request: Request, secretSalt: string) {
	const visitorIp = getVisitorIp(request);

	if (!visitorIp) return undefined;

	const year = new Date().getUTCFullYear();
	const input = `${visitorIp}:${year}:${secretSalt}`;
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', bytes);

	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

type InteractionType = 'like' | 'visit';

type ContentStats = {
	contentId: string;
	likes: number;
	visits: number;
};

// Checks whether this visitor has an active dedupe record for this content.
async function hasActiveDedupe(
	db: D1Database,
	type: InteractionType,
	contentId: string,
	visitorHash: string,
	now: number,
) {
	const row = await db
		.prepare(type === 'like' ? SQL.selectActiveLikeDedupe : SQL.selectActiveVisitDedupe)
		.bind(contentId, visitorHash, now)
		.first();

	return row !== null;
}

async function recordInteraction(
	db: D1Database,
	type: InteractionType,
	contentId: string,
	visitorHash: string,
	now: number,
	expiresAt: number,
) {
	const deleteExpiredDedupe = type === 'like' ? SQL.deleteExpiredLikeDedupe : SQL.deleteExpiredVisitDedupe;
	const insertDedupe = type === 'like' ? SQL.insertLikeDedupe : SQL.insertVisitDedupe;
	const incrementCounter = type === 'like' ? SQL.incrementLikesByClaim : SQL.incrementVisitsByClaim;

	const results = await db.batch([
		db.prepare(deleteExpiredDedupe).bind(contentId, visitorHash, now),
		db.prepare(SQL.ensureContentStats).bind(contentId),
		db.prepare(insertDedupe).bind(contentId, visitorHash, expiresAt),
		db.prepare(incrementCounter).bind(contentId),
		db.prepare(SQL.selectContentStats).bind(contentId),
	]);

	return mapStats(results.at(-1)?.results?.[0], contentId);
}

async function getAllStats(db: D1Database) {
	const rows = await db
		.prepare(SQL.selectAllContentStats)
		.all<ContentStats>();

	return rows.results.map((row) => mapStats(row, row.contentId));
}

function mapStats(row: unknown, contentId: string): ContentStats {
	const stats = typeof row === 'object' && row !== null ? row as Partial<ContentStats> : undefined;

	return {
		contentId,
		likes: Number(stats?.likes ?? 0),
		visits: Number(stats?.visits ?? 0),
	};
}

function getLikeExpiresAt() {
	const now = new Date();
	const nextYear = Date.UTC(now.getUTCFullYear() + 1, 0, 1, 0, 0, 0, 0);

	return Math.floor(nextYear / 1000);
}

// Converts any captured error into safe text for structured logs.
function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
