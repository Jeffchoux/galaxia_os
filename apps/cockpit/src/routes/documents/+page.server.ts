import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listAllDocuments } from '$lib/server/db';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	return { documents: listAllDocuments(locals.user.id, 200) };
};
