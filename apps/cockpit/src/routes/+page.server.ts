import type { PageServerLoad } from './$types';
import { listConversations, listMessages } from '$lib/server/db';
import { listBriefs } from '$lib/server/briefs';

export const load: PageServerLoad = ({ url }) => {
	const conversations = listConversations();
	const requestedId = url.searchParams.get('c');
	const active = requestedId
		? conversations.find((c) => c.id === requestedId)
		: undefined;
	const messages = active ? listMessages(active.id) : [];
	const briefs = listBriefs().slice(0, 5);
	return {
		conversations,
		active: active ?? null,
		messages,
		briefs
	};
};
