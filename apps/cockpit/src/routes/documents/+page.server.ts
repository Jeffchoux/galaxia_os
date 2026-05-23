import type { PageServerLoad } from './$types';
import { listAllDocuments } from '$lib/server/db';

export const load: PageServerLoad = () => {
	return { documents: listAllDocuments(200) };
};
