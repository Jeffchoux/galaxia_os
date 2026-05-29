import { error, json, type RequestHandler } from '@sveltejs/kit';
import { buildTree, readCodeFile } from '$lib/server/code';

// Vue Code (Galaxia 2.0 WS4), lecture seule, derrière l'auth cockpit.
// - GET /api/code            → arborescence du repo (racine getCodeRoot()).
// - GET /api/code?file=<rel> → contenu texte d'un fichier (gardes taille/binaire/traversée).
export const GET: RequestHandler = ({ locals, url }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const file = url.searchParams.get('file');
	if (file !== null) {
		const res = readCodeFile(file);
		if ('error' in res) return json(res, { status: 400 });
		return json(res);
	}
	return json(buildTree());
};
