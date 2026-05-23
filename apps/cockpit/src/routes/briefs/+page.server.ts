import type { PageServerLoad } from './$types';
import { listBriefs } from '$lib/server/briefs';

export const load: PageServerLoad = () => {
	return { briefs: listBriefs() };
};
