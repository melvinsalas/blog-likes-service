export type CommentEmail = {
	contentId: string;
	name: string;
	email?: string;
	website?: string;
	comment: string;
	createdAt: string;
};

export type CommentEmailConfig = {
	from: string;
	to: string;
};

export async function sendCommentEmail(
	binding: SendEmail,
	config: CommentEmailConfig,
	comment: CommentEmail,
) {
	await binding.send({
		from: config.from,
		to: config.to,
		...(comment.email ? { replyTo: comment.email } : {}),
		subject: `New comment · ${comment.contentId}`,
		text: createEmailBody(comment),
	});
}

function createEmailBody(comment: CommentEmail) {
	return [
		'New blog comment',
		'',
		`Post / contentId: ${comment.contentId}`,
		`Name: ${comment.name}`,
		`Email: ${comment.email ?? 'Not provided'}`,
		`Website: ${comment.website ?? 'Not provided'}`,
		`Date: ${comment.createdAt}`,
		'',
		'Comment:',
		comment.comment,
		'',
		'Markdown:',
		'```md',
		createMarkdownBlock(comment),
		'```',
	].join('\n');
}

function createMarkdownBlock(comment: CommentEmail) {
	return [
		`- name: ${quoteYamlString(comment.name)}`,
		...(comment.website ? [`  website: ${quoteYamlString(comment.website)}`] : []),
		`  date: ${comment.createdAt.slice(0, 10)}`,
		'  comment: |',
		...comment.comment.split('\n').map((line) => `    ${line}`),
	].join('\n');
}

// JSON string quoting is compatible with YAML double-quoted scalars and keeps
// names and URLs containing punctuation safe to paste into frontmatter.
function quoteYamlString(value: string) {
	return JSON.stringify(value);
}
