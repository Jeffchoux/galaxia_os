import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	appendMessage,
	createConversation,
	getConversation,
	listMessages,
	renameConversation
} from '$lib/server/db';
import { generateTitle, streamReply, toClaudeMessages } from '$lib/server/claude';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const body = (await request.json()) as { conversation_id?: string; message?: string };
	const userMessage = (body.message ?? '').trim();
	if (!userMessage) throw error(400, 'empty message');

	let conversation = body.conversation_id ? getConversation(body.conversation_id) : undefined;
	const isNew = !conversation;
	if (!conversation) conversation = createConversation();

	appendMessage(conversation.id, 'user', userMessage);
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
				for await (const chunk of streamReply(toClaudeMessages(history))) {
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
