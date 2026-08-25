# Blog API

An HTTP API for the interactive features of an Astro blog, implemented as a Cloudflare Worker.

The API stores likes in Cloudflare D1 and delivers comment submissions directly by email through Cloudflare Email Service. Markdown remains the only source of truth: comments are never stored in D1 or another database.

## API Overview

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/stats/` | Returns all permanent like and visit counters. |
| `GET` | `/api/stats/:contentId` | Records one deduped visit and returns counters for the content item. |
| `POST` | `/api/like/:contentId` | Records one like from the current visitor and returns updated counters. |
| `POST` | `/api/comments/:contentId` | Validates a comment and emails it with a Markdown block ready to paste into the post. |
| `OPTIONS` | `/api/*` | Handles browser CORS preflight requests. |

Example base URL:

```txt
https://blog-likes-service.<your-subdomain>.workers.dev
```

All API responses use JSON except successful `OPTIONS` responses, which have no body. Responses are not cached.

## Resource IDs

`:contentId` identifies the blog post or content item. Use a stable slug, path, or namespaced ID rather than a title that may change.

The API URL-decodes and lowercases the value, removes leading and trailing slashes, and replaces internal `/` characters with `-`. The normalized ID must be no more than 120 characters, must start and end with a letter or number, and may contain lowercase letters, numbers, `-`, and `:`.

```txt
my-first-post          -> my-first-post
blog:my-first-post     -> blog:my-first-post
/blog/hola-archive     -> blog-hola-archive
blog/2026/hello-world  -> blog-2026-hello-world
```

## Endpoint Specification

### Get All Stats

```http
GET /api/stats/
```

Returns all permanent content counters. This endpoint does not create a visitor fingerprint and does not record a visit.

#### Successful response

Status: `200 OK`

```json
{
  "stats": [
    {
      "contentId": "blog:post-1",
      "likes": 532,
      "visits": 8120
    }
  ]
}
```

### Get Content Stats

```http
GET /api/stats/:contentId
```

Records one deduped visit from the current visitor, then returns permanent counters and whether the requesting visitor has already liked the content.

#### Successful response

Status: `200 OK`

```json
{
  "contentId": "blog:post-1",
  "likes": 532,
  "visits": 8120,
  "liked": true
}
```

#### Errors

- `400` if the visitor address is unavailable.
- `403` if the browser origin is not allowed.
- `404` if `contentId` is missing or invalid.
- `405` if the endpoint receives an unsupported HTTP method.
- `500` if the service is not configured or D1 fails.

### Add Like

```http
POST /api/like/:contentId
```

Records a like from the current visitor. It is idempotent while the like dedupe record is active: submitting the same like again does not increase the count.

#### Successful response

Status: `200 OK`

```json
{
  "contentId": "blog:post-1",
  "likes": 533,
  "visits": 8120,
  "liked": true
}
```

### Submit Comment

```http
POST /api/comments/:contentId
Content-Type: application/json
```

Validates a comment and its Cloudflare Turnstile token, then sends it directly to the configured inbox through Cloudflare Email Service. The email contains the submission details and a Markdown block ready to copy into the corresponding post.

#### Request body

```json
{
  "name": "Ada",
  "email": "ada@example.com",
  "website": "https://example.com",
  "comment": "Thanks for the post!",
  "turnstileToken": "TOKEN_FROM_THE_TURNSTILE_WIDGET"
}
```

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Non-empty, no control characters, maximum 80 characters. |
| `email` | `string` | No | Valid email address, maximum 254 characters. |
| `website` | `string` | No | HTTP or HTTPS URL without embedded credentials, maximum 500 characters. |
| `comment` | `string` | Yes | Non-empty, maximum 5,000 characters. |
| `turnstileToken` | `string` | Yes | Token produced by the Turnstile widget, maximum 2,048 characters. |

The default Turnstile field name, `cf-turnstile-response`, is accepted as an alternative to `turnstileToken`. The complete JSON body is limited to 12,000 bytes.

#### Successful response

Status: `200 OK`

```json
{
  "ok": true
}
```

| Field | Type | Description |
| --- | --- | --- |
| `ok` | `boolean` | Always `true` after Email Service accepts the message. |

#### Errors

- `400` if the JSON or any field is invalid.
- `403` if the origin is not allowed or Turnstile rejects the token.
- `404` if `contentId` is missing or invalid.
- `405` if the endpoint receives a method other than `POST` or `OPTIONS`.
- `413` if the request body exceeds 12,000 bytes.
- `415` if `Content-Type` is not `application/json`.
- `500` if the comments service is not configured.
- `502` if Turnstile or Cloudflare Email Service cannot complete the submission.

#### Email contents

The subject uses `New comment · <contentId>`. The plain-text body clearly includes the content ID, name, optional email, optional website, comment, and UTC date. When the visitor provides an email, it is also used as `Reply-To`.

The message ends with a block that can be copied into the post:

```md
- name: "Ada"
  website: "https://example.com"
  date: 2026-08-22
  comment: |
    Thanks for the post!
```

The optional email is intentionally excluded from this Markdown block so it is not published accidentally.

### CORS Preflight

```http
OPTIONS /api/*
```

Returns `204 No Content` for an allowed origin. Browser requests may send `Accept` and `Content-Type` headers and use `GET`, `POST`, or `OPTIONS`. Requests from an origin not listed in `ALLOWED_ORIGINS` return `403`.

## How It Works

The Worker reads the visitor IP from Cloudflare's `CF-Connecting-IP` header. Then it immediately does the polite thing: it does not store that IP. Instead, it creates a SHA-256 hash from:

```txt
IP + UTC year + SECRET_SALT
```

That hash becomes the visitor identifier for deduplication. The current UTC year is included so the identifier rotates yearly. `SECRET_SALT` must be configured as a Wrangler secret and must not be committed. Seriously: no secret sauce in Git.

Interactions are deduped in D1 with this unique key:

```txt
content_id + fingerprint
```

The permanent counters live in `content_stats`. Fingerprints live in `like_dedupe` and `visit_dedupe` only while they are useful for deduplication. Public counters are never calculated with `COUNT(*)` over fingerprint rows, so deleting expired dedupe records does not lower historical likes or visits.

The `POST` endpoints use a D1 batch transaction and the dedupe table primary key to make duplicate submissions idempotent. The Worker deletes the expired dedupe row for the current fingerprint, inserts the new dedupe claim with `INSERT OR IGNORE`, and increments the permanent counter by SQLite `changes()` from that claim. Only a request that inserts the dedupe claim increments the counter.

Likes preserve the existing yearly visitor fingerprint behavior: the active like dedupe row expires at the start of the next UTC year. Visits use a 24-hour dedupe window.

### D1 Schema

Migration `0002_create_content_stats.sql` renames the old `likes` table to `legacy_likes`, creates the new tables, backfills permanent like counters from legacy rows, and seeds like dedupe rows from the legacy visitor hashes.

The new base schema is:

```sql
CREATE TABLE IF NOT EXISTS content_stats (
	content_id TEXT PRIMARY KEY,
	likes INTEGER NOT NULL DEFAULT 0,
	visits INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS like_dedupe (
	content_id TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (content_id, fingerprint)
);

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
```

The migration keeps legacy data in:

```txt
legacy_likes
```

## Project Structure

```txt
src/index.ts                  Worker request handling, CORS, hashing, D1 calls
src/comments.ts               Comment payload validation and submission flow
src/email.ts                  Email formatting and Cloudflare Email Service call
src/turnstile.ts              Server-side Turnstile validation
src/sql.ts                    SQL statements used by the Worker
migrations/0001_create_likes.sql
migrations/0002_create_content_stats.sql
wrangler.jsonc                Worker, D1 binding, and deploy config
.dev.vars.example             Local variables example
```

## Configuration

Most of the important knobs live in `wrangler.jsonc`:

- Worker name: `blog-likes-service`
- D1 binding: `DB`
- D1 database: `blog-likes`
- Email Service binding: `COMMENTS_EMAIL`
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
wrangler secret put TURNSTILE_SECRET_KEY
```

`TURNSTILE_SECRET_KEY` is the private key from the Turnstile widget; the public sitekey belongs in the Astro frontend, not in this Worker.

### Email Service

The Worker declares this Email Service binding in `wrangler.jsonc`:

```json
"send_email": [
  {
    "name": "COMMENTS_EMAIL"
  }
]
```

Before deploying, enable Cloudflare Email Service for the account, onboard the domain used by the sender, and verify the destination address. A binding without a destination restriction can only send to destination addresses verified in the Cloudflare account.

Configure the sender and destination as non-secret variables in Cloudflare Dashboard alongside `ALLOWED_ORIGINS`:

```txt
COMMENTS_EMAIL_FROM=comments@your-domain.example
COMMENTS_EMAIL_TO=you@example.com
```

`COMMENTS_EMAIL_FROM` must belong to the domain onboarded to Email Service. `COMMENTS_EMAIL_TO` must be a verified destination. The addresses stay out of `wrangler.jsonc` so `keep_vars: true` continues to preserve Dashboard-managed configuration.

For local development:

```sh
cp .dev.vars.example .dev.vars
```

Then edit `.dev.vars` with a local-only salt. It does not need to match production.

For local comment validation, use Turnstile's official test keys. Real email delivery requires a configured Email Service binding; do not put real secrets in `.dev.vars.example` or commit `.dev.vars`.

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

Try the endpoint with a slug:

```sh
curl http://localhost:8787/api/stats/example-post
```

Or with a path:

```sh
curl http://localhost:8787/api/stats/blog/hola-archive
```

Try a comment submission after filling the local variables:

```sh
curl -X POST http://localhost:8787/api/comments/example-post \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","comment":"Thanks!","turnstileToken":"TURNSTILE_TOKEN"}'
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

## Using the Blog API From JavaScript

Use browser-side `fetch` with `credentials: 'omit'`. Treat this service as optional: if it fails, your UI should shrug and keep rendering.

```ts
const blogApi = 'https://blog-likes-service.<your-subdomain>.workers.dev';
const postId = location.pathname;

export async function getStats() {
	try {
		const res = await fetch(`${blogApi}/api/stats/${encodeURIComponent(postId)}`, {
			credentials: 'omit',
			headers: { Accept: 'application/json' },
		});

		return res.ok ? await res.json() : { contentId: postId, likes: 0, visits: 0, liked: false };
	} catch {
		return { contentId: postId, likes: 0, visits: 0, liked: false };
	}
}

export async function likePost() {
	try {
		const res = await fetch(`${blogApi}/api/like/${encodeURIComponent(postId)}`, {
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

The Worker returns JSON errors for invalid routes, invalid input, failed Turnstile challenges, disallowed origins, missing configuration, unavailable visitor IPs, Email Service/Turnstile failures, and unexpected server errors.

The client should catch failed requests and continue rendering normally. A failed likes request should only affect the like button or counter, not the rest of the page.
