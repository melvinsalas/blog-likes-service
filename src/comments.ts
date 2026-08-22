import { sendCommentEmail } from './email';
import { verifyTurnstile } from './turnstile';

const MAX_BODY_BYTES = 12_000;
const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 254;
const MAX_WEBSITE_LENGTH = 500;
const MAX_COMMENT_LENGTH = 5_000;
const MAX_TURNSTILE_TOKEN_LENGTH = 2_048;

export type CommentsEnv = {
	COMMENTS_EMAIL?: SendEmail;
	COMMENTS_EMAIL_FROM?: string;
	COMMENTS_EMAIL_TO?: string;
	TURNSTILE_SECRET_KEY?: string;
};

export type CommentResponse = {
	status: number;
	body: unknown;
};

type CommentSubmission = {
	name: string;
	email?: string;
	website?: string;
	comment: string;
	turnstileToken: string;
};

export async function submitComment(
	request: Request,
	env: CommentsEnv,
	contentId: string,
): Promise<CommentResponse> {
	const configuration = getConfiguration(env);

	if (!configuration) {
		return { status: 500, body: { error: 'Comments service not configured' } };
	}

	let submission: CommentSubmission;

	try {
		submission = await parseSubmission(request);
	} catch (error) {
		if (error instanceof InputError) {
			return { status: error.status, body: { error: error.message } };
		}

		throw error;
	}

	try {
		const turnstile = await verifyTurnstile(
			configuration.turnstileSecret,
			submission.turnstileToken,
			getClientIp(request),
		);

		if (!turnstile.success) {
			console.warn(
				JSON.stringify({
					message: 'turnstile_validation_failed',
					errorCodes: turnstile.errorCodes,
				}),
			);

			return { status: 403, body: { error: 'Turnstile validation failed' } };
		}

		await sendCommentEmail(
			configuration.emailBinding,
			{
				from: configuration.emailFrom,
				to: configuration.emailTo,
			},
			{
				contentId,
				name: submission.name,
				email: submission.email,
				website: submission.website,
				comment: submission.comment,
				createdAt: new Date().toISOString(),
			},
		);

		return {
			status: 200,
			body: { ok: true },
		};
	} catch (error) {
		console.error(
			JSON.stringify({ message: 'comment_submission_failed', error: getErrorMessage(error) }),
		);

		return { status: 502, body: { error: 'Could not send comment' } };
	}
}

async function parseSubmission(request: Request): Promise<CommentSubmission> {
	const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();

	if (contentType !== 'application/json') {
		throw new InputError('Content-Type must be application/json', 415);
	}

	const declaredLength = Number(request.headers.get('Content-Length'));

	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
		throw new InputError('Request body is too large', 413);
	}

	const bytes = await request.arrayBuffer();

	if (bytes.byteLength > MAX_BODY_BYTES) {
		throw new InputError('Request body is too large', 413);
	}

	let value: unknown;

	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new InputError('Request body must be valid JSON');
	}

	if (!isRecord(value)) {
		throw new InputError('Request body must be a JSON object');
	}

	const name = readString(value, 'name', true, MAX_NAME_LENGTH);
	const email = readString(value, 'email', false, MAX_EMAIL_LENGTH);
	const website = readString(value, 'website', false, MAX_WEBSITE_LENGTH);
	const comment = readString(value, 'comment', true, MAX_COMMENT_LENGTH, false);
	const turnstileToken = readTurnstileToken(value);

	if (hasControlCharacters(name)) {
		throw new InputError('name contains invalid characters');
	}

	if (email && !isValidEmail(email)) {
		throw new InputError('email must be a valid email address');
	}

	if (website && !isValidWebsite(website)) {
		throw new InputError('website must be an http or https URL');
	}

	return { name, email, website, comment, turnstileToken };
}

function readString(
	value: Record<string, unknown>,
	field: string,
	required: true,
	maxLength: number,
	trim?: boolean,
): string;
function readString(
	value: Record<string, unknown>,
	field: string,
	required: false,
	maxLength: number,
	trim?: boolean,
): string | undefined;
function readString(
	value: Record<string, unknown>,
	field: string,
	required: boolean,
	maxLength: number,
	trim = true,
) {
	const raw = value[field];

	if (raw === undefined || raw === null || raw === '') {
		if (required) throw new InputError(`${field} is required`);
		return undefined;
	}

	if (typeof raw !== 'string') {
		throw new InputError(`${field} must be a string`);
	}

	const normalized = trim ? raw.trim() : raw.trimEnd();

	if (!normalized.trim()) {
		if (required) throw new InputError(`${field} is required`);
		return undefined;
	}

	if (normalized.length > maxLength) {
		throw new InputError(`${field} must be ${maxLength} characters or fewer`);
	}

	return normalized;
}

function readTurnstileToken(value: Record<string, unknown>) {
	const raw = value.turnstileToken ?? value['cf-turnstile-response'];

	if (typeof raw !== 'string' || !raw.trim()) {
		throw new InputError('turnstileToken is required');
	}

	const token = raw.trim();

	if (token.length > MAX_TURNSTILE_TOKEN_LENGTH) {
		throw new InputError(`turnstileToken must be ${MAX_TURNSTILE_TOKEN_LENGTH} characters or fewer`);
	}

	return token;
}

function isValidEmail(email: string) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidWebsite(website: string) {
	try {
		const url = new URL(website);
		return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
	} catch {
		return false;
	}
}

function hasControlCharacters(value: string) {
	return /[\u0000-\u001f\u007f]/.test(value);
}

function getConfiguration(env: CommentsEnv) {
	if (
		!env.COMMENTS_EMAIL ||
		!env.COMMENTS_EMAIL_FROM ||
		!env.COMMENTS_EMAIL_TO ||
		!env.TURNSTILE_SECRET_KEY
	) {
		return undefined;
	}

	return {
		emailBinding: env.COMMENTS_EMAIL,
		emailFrom: env.COMMENTS_EMAIL_FROM,
		emailTo: env.COMMENTS_EMAIL_TO,
		turnstileSecret: env.TURNSTILE_SECRET_KEY,
	};
}

function getClientIp(request: Request) {
	return request.headers.get('CF-Connecting-IP')?.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

class InputError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}
