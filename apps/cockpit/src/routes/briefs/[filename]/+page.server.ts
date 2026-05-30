import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { readBrief } from '$lib/server/briefs';
import { renderMarkdownSafe } from '$lib/server/markdown';

export const load: PageServerLoad = ({ params }) => {
	const brief = readBrief(params.filename);
	if (!brief) throw error(404, 'brief introuvable');
	// HTML assaini : le brief est injecté via {@html} dans l'origine du cockpit.
	const html = renderMarkdownSafe(brief.content);
	return { brief, html };
};
