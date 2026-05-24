import { redirect, type Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, verifySession } from '$lib/server/auth';
import { ensureMigrated, getUserById } from '$lib/server/db';

// Boot-time : déclenche la migration SQLite (création tables + provision admin)
// dès l'import du module hooks. Si ADMIN_EMAIL ou autre env requise manque,
// le service crashe au boot plutôt qu'à la 1re requête utilisateur.
ensureMigrated();

const PUBLIC_PATHS = new Set(['/login']);

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	const session = verifySession(token);
	// On rehydrate l'utilisateur depuis la DB à chaque requête : c'est cheap
	// (PK lookup SQLite) et garantit qu'un user supprimé est immédiatement déconnecté.
	const dbUser = session ? getUserById(session.userId) : null;
	event.locals.user = dbUser
		? { id: dbUser.id, email: dbUser.email, role: dbUser.role }
		: null;

	const path = event.url.pathname;
	const isPublic = PUBLIC_PATHS.has(path) || path.startsWith('/_app/');

	if (!event.locals.user && !isPublic) {
		throw redirect(303, `/login?next=${encodeURIComponent(path)}`);
	}
	if (event.locals.user && path === '/login') {
		throw redirect(303, '/');
	}

	return resolve(event);
};
