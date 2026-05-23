import { fail, redirect, type Actions } from '@sveltejs/kit';
import {
	SESSION_COOKIE,
	createSession,
	sessionCookieOptions,
	verifyPassword
} from '$lib/server/auth';

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const ok = await verifyPassword(password);
		if (!ok) {
			return fail(401, { error: 'Mot de passe incorrect.' });
		}
		cookies.set(SESSION_COOKIE, createSession('jeff'), sessionCookieOptions());
		const next = url.searchParams.get('next') || '/';
		throw redirect(303, next.startsWith('/') ? next : '/');
	}
};
