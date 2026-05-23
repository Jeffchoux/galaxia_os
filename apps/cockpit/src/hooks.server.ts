import { redirect, type Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, verifySession } from '$lib/server/auth';

const PUBLIC_PATHS = new Set(['/login']);

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	const session = verifySession(token);
	event.locals.user = session ? { id: session.userId } : null;

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
