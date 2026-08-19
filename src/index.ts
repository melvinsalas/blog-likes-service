import { SQL } from './sql';

type AppEnv = Env & {
	// ALLOWED_ORIGINS is configured outside wrangler.jsonc so deployments can
	// keep Dashboard-managed variables.
	ALLOWED_ORIGINS?: string;
	// SECRET_SALT is a Wrangler secret. It is optional here so the Worker can
	// return a clear error if it is missing locally or in production.
	SECRET_SALT?: string;
};

// Normalize paths into simple postId values to avoid ambiguous routes or odd input.
const POST_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;
const API_ROUTE_PATTERN = /^\/api\/likes\/(.+)$/;
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

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
			const postId = getPostId(url);

			if (!postId) {
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

			if (request.method === 'GET') {
				const [liked, count] = await Promise.all([
					hasLiked(env.DB, postId, visitorHash),
					getCount(env.DB, postId),
				]);

				return jsonResponse(request, allowedOrigins, { liked, count });
			}

			// POST records the like. The SQL helper dedupes through the
			// (post_id, visitor_hash) primary key, so repeated clicks do not duplicate.
			if (request.method === 'POST') {
				await env.DB.prepare(SQL.insertLike)
					.bind(postId, visitorHash, Math.floor(Date.now() / 1000))
					.run();

				return jsonResponse(request, allowedOrigins, { liked: true, count: await getCount(env.DB, postId) });
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

function getPostId(url: URL) {
	const rawPostId = url.pathname.match(API_ROUTE_PATTERN)?.[1]?.replace(/\/+$/, '');

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

// Checks whether this visitor already has a like for this post.
async function hasLiked(db: D1Database, postId: string, visitorHash: string) {
	const row = await db
		.prepare(SQL.selectExistingLike)
		.bind(postId, visitorHash)
		.first();

	return row !== null;
}

// Counts all likes recorded for a post.
async function getCount(db: D1Database, postId: string) {
	const row = await db
		.prepare(SQL.countLikes)
		.bind(postId)
		.first<{ count: number }>();

	return Number(row?.count ?? 0);
}

// Converts any captured error into safe text for structured logs.
function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
