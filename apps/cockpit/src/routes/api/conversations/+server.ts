import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createConversation } from '$lib/server/db';

// Crée une conversation vide. Utilisé par le client quand on veut attacher
// un document avant d'avoir échangé un premier message.
export const POST: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conv = createConversation(locals.user.id);
	return json({ conversation: conv });
};
