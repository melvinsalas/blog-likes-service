const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type SiteverifyResponse = {
	success?: boolean;
	'error-codes'?: string[];
};

export type TurnstileResult = {
	success: boolean;
	errorCodes: string[];
};

// Turnstile tokens are single-use, so validation must happen immediately
// before sending the comment email.
export async function verifyTurnstile(
	secret: string,
	token: string,
	remoteIp?: string,
): Promise<TurnstileResult> {
	const body = new FormData();
	body.set('secret', secret);
	body.set('response', token);
	body.set('idempotency_key', crypto.randomUUID());

	if (remoteIp) {
		body.set('remoteip', remoteIp);
	}

	const response = await fetch(SITEVERIFY_URL, {
		method: 'POST',
		body,
	});

	if (!response.ok) {
		throw new Error(`Turnstile Siteverify returned HTTP ${response.status}`);
	}

	const result = (await response.json()) as SiteverifyResponse;

	return {
		success: result.success === true,
		errorCodes: Array.isArray(result['error-codes']) ? result['error-codes'] : [],
	};
}
