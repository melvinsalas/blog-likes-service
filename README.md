# blog-likes-service

Tiny Cloudflare Worker for likes/upvotes on web content.

It does one job: receive like requests, count them in Cloudflare D1, and stay out of the way. No cookies, no `localStorage`, no big framework energy.

## What It Does

- Returns the current like count for a post or content item.
- Tells the current visitor whether they already liked it.
- Records one like per visitor per post.
- Deduplicates repeat likes without storing raw IP addresses.
- Restricts browser access to the origins listed in `ALLOWED_ORIGINS`.
- Fails quietly enough that your page can keep doing its thing if the API is down.

## API

### `GET /api/likes/:postId`

Checks the current state for one post: did this visitor like it, and how many likes does it have?

```json
{ "liked": false, "count": 0 }
```

### `POST /api/likes/:postId`

Adds a like for the current visitor and returns the updated count.

```json
{ "liked": true, "count": 1 }
```

`postId` should be a stable slug made of lowercase letters, numbers, and hyphens. Use something boring and permanent, like `my-first-post`, not a display title that might change next week.

## How It Works

The Worker reads the visitor IP from Cloudflare's `CF-Connecting-IP` header. Then it immediately does the polite thing: it does not store that IP. Instead, it creates a SHA-256 hash from:

```txt
IP + UTC year + SECRET_SALT
```

That hash becomes the visitor identifier for deduplication. The current UTC year is included so the identifier rotates yearly. `SECRET_SALT` must be configured as a Wrangler secret and must not be committed. Seriously: no secret sauce in Git.

Likes are stored in D1 with this unique key:

```txt
post_id + visitor_hash
```

The `POST` endpoint uses an idempotent insert, so enthusiastic clicking does not create duplicate likes.

## Project Structure

```txt
src/index.ts                  Worker request handling, CORS, hashing, D1 calls
src/sql.ts                    SQL statements used by the Worker
migrations/0001_create_likes.sql
wrangler.jsonc                Worker, D1 binding, and deploy config
.dev.vars.example             Local variables example
```

## Configuration

Most of the important knobs live in `wrangler.jsonc`:

- Worker name: `blog-likes-service`
- D1 binding: `DB`
- D1 database: `blog-likes`
- Dashboard-managed variables are preserved with `keep_vars: true`

`ALLOWED_ORIGINS` is intentionally kept out of `wrangler.jsonc`. Set it in Cloudflare Dashboard so changing your site URL does not require a code change:

```txt
Worker > Settings > Variables & Secrets > Add variable
Name: ALLOWED_ORIGINS
Value: https://your-site.example.com
```

Use a comma-separated list if you need more than one origin, for example `http://localhost:4321,https://your-site.example.com`.

For production, configure the secret once:

```sh
wrangler secret put SECRET_SALT
```

For local development:

```sh
copy .dev.vars.example .dev.vars
```

Then edit `.dev.vars` with a local-only salt. It does not need to match production.

## Local Development

Install dependencies:

```sh
npm install
```

Apply local D1 migrations:

```sh
npm run db:migrate:local
```

Start the Worker locally:

```sh
npm run dev
```

Try the endpoint:

```sh
curl http://localhost:8787/api/likes/example-post
```

## Deployment

Apply remote D1 migrations first:

```sh
npm run db:migrate:remote
```

Then deploy the Worker:

```sh
npm run deploy
```

Want to check the deploy without actually shipping it? Dry-run it:

```sh
npm run deploy -- --dry-run
```

## Cloudflare Builds

If the Worker is connected to a Git repository through Cloudflare Workers Builds, use these settings and let Cloudflare handle the boring part on each push:

```txt
Production branch: master
Build command: npm run check
Deploy command: npm run db:migrate:remote && npm run deploy
```

The Cloudflare build token must have permission to deploy Workers and edit D1. If migrations fail in the build, permissions are the first thing to check.

## Usage From JavaScript

Use browser-side `fetch` with `credentials: 'omit'`. Treat this service as optional: if it fails, your UI should shrug and keep rendering.

```ts
const likesApi = 'https://blog-likes-service.<your-subdomain>.workers.dev';
const postId = 'example-post';

export async function getLikes() {
	try {
		const res = await fetch(`${likesApi}/api/likes/${encodeURIComponent(postId)}`, {
			credentials: 'omit',
			headers: { Accept: 'application/json' },
		});

		return res.ok ? await res.json() : { liked: false, count: 0 };
	} catch {
		return { liked: false, count: 0 };
	}
}

export async function likePost() {
	try {
		const res = await fetch(`${likesApi}/api/likes/${encodeURIComponent(postId)}`, {
			method: 'POST',
			credentials: 'omit',
			headers: { Accept: 'application/json' },
		});

		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}
```

## Scripts

```txt
npm run dev                Start local Worker development
npm run check              Generate Worker types and run TypeScript checks
npm run db:migrate:local   Apply D1 migrations locally
npm run db:migrate:remote  Apply D1 migrations to Cloudflare
npm run deploy             Deploy the Worker
```

## Failure Behavior

The Worker returns JSON errors for invalid routes, disallowed origins, missing configuration, unavailable visitor IPs, and unexpected server errors.

The client should catch failed requests and continue rendering normally. A failed likes request should only affect the like button or counter, not the rest of the page.
