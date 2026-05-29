import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
	listConversationDocuments,
	listConversations,
	listMessages,
	listProjects
} from '$lib/server/db';
import { listBriefs } from '$lib/server/briefs';

export const load: PageServerLoad = ({ url, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const userId = locals.user.id;
	const conversations = listConversations(userId);
	const projects = listProjects(userId);
	const requestedId = url.searchParams.get('c');
	const active = requestedId
		? conversations.find((c) => c.id === requestedId)
		: undefined;
	const messages = active ? listMessages(active.id, userId) : [];
	const documents = active ? listConversationDocuments(active.id, userId) : [];
	const briefs = listBriefs().slice(0, 5);
	return {
		conversations,
		projects,
		active: active ?? null,
		messages,
		documents,
		briefs
	};
};
