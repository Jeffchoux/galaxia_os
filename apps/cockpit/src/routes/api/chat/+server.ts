import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	appendMessage,
	createConversation,
	getConversation,
	listMessages,
	loadConversationDocuments,
	renameConversation,
	updateSummary,
	type Conversation
} from '$lib/server/db';
import {
	generateTitle,
	shouldSummarize,
	streamReply,
	summarizeHistory
} from '$lib/server/claude';

async function maybeSummarize(conversation: Conversation, userId: string): Promise<void> {
	try {
		const refreshed = getConversation(conversation.id, userId);
		if (!refreshed) return;
		const history = listMessages(refreshed.id, userId);
		if (!shouldSummarize(refreshed, history)) return;
		const { summary, until_idx } = await summarizeHistory(refreshed, history, userId);
		if (summary && until_idx > refreshed.summary_until_idx) {
			updateSummary(refreshed.id, userId, summary, until_idx);
		}
	} catch (e) {
		console.error('summarize failed', e);
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const userId = locals.user.id;

	const body = (await request.json()) as { conversation_id?: string; message?: string };
	const userMessage = (body.message ?? '').trim();
	if (!userMessage) throw error(400, 'empty message');

	let conversation = body.conversation_id
		? getConversation(body.conversation_id, userId)
		: undefined;
	const isNew = !conversation;
	if (!conversation) conversation = createConversation(userId);

	appendMessage(conversation.id, userId, 'user', userMessage);
	// Refresh conversation after appending (summary/summary_until_idx untouched here)
	const convAtTurnStart = getConversation(conversation.id, userId) ?? conversation;
	const history = listMessages(conversation.id, userId);
	const docs = loadConversationDocuments(conversation.id, userId);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			send('conversation', { id: conversation.id, title: conversation.title, is_new: isNew });

			let assistantText = '';
			try {
				for await (const event of streamReply(convAtTurnStart, history, docs, userId)) {
					if (event.kind === 'delta') {
						assistantText += event.text;
						send('delta', { text: event.text });
					} else if (event.kind === 'tool_use') {
						send('tool_use', { id: event.id, name: event.name, input: event.input });
					} else if (event.kind === 'tool_result') {
						send('tool_result', {
							id: event.id,
							name: event.name,
							result: event.result,
							is_error: event.is_error ?? false
						});
					}
				}
				appendMessage(conversation.id, userId, 'assistant', assistantText);

				if (isNew) {
					const title = await generateTitle(userMessage, userId, conversation.id);
					renameConversation(conversation.id, userId, title);
					send('title', { title });
				}
				send('done', { ok: true });

				// Résumé asynchrone (non bloquant pour le client : le stream est déjà fermé en dessous)
				maybeSummarize(conversation, userId);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (assistantText) {
					appendMessage(conversation.id, userId, 'assistant', assistantText);
				}
				send('error', { message: msg });
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			'x-accel-buffering': 'no'
		}
	});
};

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = url.searchParams.get('conversation_id');
	if (!id) throw error(400, 'missing conversation_id');
	const conv = getConversation(id, locals.user.id);
	if (!conv) throw error(404, 'conversation not found');
	return json({ conversation: conv, messages: listMessages(id, locals.user.id) });
};
