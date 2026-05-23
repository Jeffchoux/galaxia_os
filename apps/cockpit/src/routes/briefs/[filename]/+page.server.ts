import { error } from '@sveltejs/kit';
import { marked } from 'marked';
import type { PageServerLoad } from './$types';
import { readBrief } from '$lib/server/briefs';

export const load: PageServerLoad = ({ params }) => {
	const brief = readBrief(params.filename);
	if (!brief) throw error(404, 'brief introuvable');
	const html = marked.parse(brief.content, { gfm: true, breaks: true }) as string;
	return { brief, html };
};
