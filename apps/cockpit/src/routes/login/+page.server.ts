import { fail, redirect, type Actions } from '@sveltejs/kit';
import {
	SESSION_COOKIE,
	createSession,
	sessionCookieOptions,
	verifyPassword
} from '$lib/server/auth';
import { getAdminUser } from '$lib/server/db';

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const ok = await verifyPassword(password);
		if (!ok) {
			return fail(401, { error: 'Mot de passe incorrect.' });
		}
		// Le password est celui de l'admin (Jeff). On résout son user_id réel
		// pour que le reste du système traite admin = user comme tout le monde.
		const admin = getAdminUser();
		cookies.set(SESSION_COOKIE, createSession(admin.id), sessionCookieOptions());
		const next = url.searchParams.get('next') || '/';
		throw redirect(303, next.startsWith('/') ? next : '/');
	}
};
