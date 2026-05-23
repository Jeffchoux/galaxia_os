import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	appendMessage,
	createConversation,
	getConversation,
	listMessages,
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

async function maybeSummarize(conversation: Conversation): Promise<void> {
	try {
		const refreshed = getConversation(conversation.id);
		if (!refreshed) return;
		const history = listMessages(refreshed.id);
		if (!shouldSummarize(refreshed, history)) return;
		const { summary, until_idx } = await summarizeHistory(refreshed, history);
		if (summary && until_idx > refreshed.summary_until_idx) {
			updateSummary(refreshed.id, summary, until_idx);
		}
	} catch (e) {
		console.error('summarize failed', e);
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const body = (await request.json()) as { conversation_id?: string; message?: string };
	const userMessage = (body.message ?? '').trim();
	if (!userMessage) throw error(400, 'empty message');

	let conversation = body.conversation_id ? getConversation(body.conversation_id) : undefined;
	const isNew = !conversation;
	if (!conversation) conversation = createConversation();

	appendMessage(conversation.id, 'user', userMessage);
	// Refresh conversation after appending (summary/summary_until_idx untouched here)
	const convAtTurnStart = getConversation(conversation.id) ?? conversation;
	const history = listMessages(conversation.id);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			send('conversation', { id: conversation.id, title: conversation.title, is_new: isNew });

			let assistantText = '';
			try {
				for await (const chunk of streamReply(convAtTurnStart, history)) {
					assistantText += chunk;
					send('delta', { text: chunk });
				}
				appendMessage(conversation.id, 'assistant', assistantText);

				if (isNew) {
					const title = await generateTitle(userMessage);
					renameConversation(conversation.id, title);
					send('title', { title });
				}
				send('done', { ok: true });

				// Résumé asynchrone (non bloquant pour le client : le stream est déjà fermé en dessous)
				maybeSummarize(conversation);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (assistantText) {
					appendMessage(conversation.id, 'assistant', assistantText);
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
	const conv = getConversation(id);
	if (!conv) throw error(404, 'conversation not found');
	return json({ conversation: conv, messages: listMessages(id) });
};
