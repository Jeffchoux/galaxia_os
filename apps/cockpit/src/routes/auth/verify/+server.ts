import { redirect, type RequestHandler } from '@sveltejs/kit';
import { SESSION_COOKIE, createSession, sessionCookieOptions } from '$lib/server/auth';
import { consumeMagicLink, getUserByEmail } from '$lib/server/db';

// Cible des magic links envoyés par mail. L'utilisateur arrive sans session ;
// on consomme le token (atomique : un seul appel réussit, même en cas de
// double-clic). Si OK, on pose le cookie de session et on redirige.
//
// Pas d'API JSON : on est dans un flow navigateur direct, donc redirect 303
// vers /login?error=... en cas d'échec pour ne pas afficher de JSON brut.

function safeNextPath(raw: string | null): string {
	if (!raw) return '/';
	return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export const GET: RequestHandler = ({ url, cookies }) => {
	const token = url.searchParams.get('token');
	if (!token) throw redirect(303, '/login?error=missing-token');

	const email = consumeMagicLink(token);
	if (!email) throw redirect(303, '/login?error=invalid-or-expired');

	const user = getUserByEmail(email);
	if (!user) {
		// Email retiré de la table users entre la création du lien et son usage.
		throw redirect(303, '/login?error=user-not-found');
	}

	cookies.set(SESSION_COOKIE, createSession(user.id), sessionCookieOptions());
	throw redirect(303, safeNextPath(url.searchParams.get('next')));
};
