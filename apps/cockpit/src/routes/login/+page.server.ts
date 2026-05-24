import { fail, redirect, type Actions } from '@sveltejs/kit';
import {
	SESSION_COOKIE,
	createSession,
	sessionCookieOptions,
	verifyPassword
} from '$lib/server/auth';
import { createMagicLink, getAdminUser, getUserByEmail } from '$lib/server/db';
import { sendMagicLink } from '$lib/server/mail';

// Valide loosement (RFC 5321 strict est plus complexe ; ça suffit pour
// éliminer les saisies évidemment cassées). Validation finale = "l'email
// existe dans la table users".
function isPlausibleEmail(s: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

function safeNextPath(raw: string | null): string {
	if (!raw) return '/';
	// Anti open-redirect : on n'accepte que les paths relatifs commençant par /
	// mais pas // (qui serait interprété comme schemeless URL absolue).
	return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export const actions: Actions = {
	// Form action `password` — admin uniquement (Jeff). SvelteKit interdit
	// `default` quand on a aussi des actions nommées, donc on nomme aussi
	// celle-ci. La form HTML doit cibler explicitement `?/password`.
	password: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const ok = await verifyPassword(password);
		if (!ok) {
			return fail(401, { error: 'Mot de passe incorrect.' });
		}
		const admin = getAdminUser();
		cookies.set(SESSION_COOKIE, createSession(admin.id), sessionCookieOptions());
		throw redirect(303, safeNextPath(url.searchParams.get('next')));
	},

	// Form action `magicLink` — demande d'envoi d'un lien temporaire. Allow-list :
	// seuls les emails déjà en table `users` sont éligibles (l'admin pré-provisionne
	// les membres). Pour ne PAS divulguer quels emails sont en base, on retourne
	// toujours le même message "lien envoyé si l'adresse est connue".
	magicLink: async ({ request, url }) => {
		const data = await request.formData();
		const rawEmail = String(data.get('email') ?? '').trim().toLowerCase();
		if (!isPlausibleEmail(rawEmail)) {
			return fail(400, { magic: { error: 'Adresse mail invalide.' } });
		}

		// Allow-list silencieuse : si l'email n'est pas en base, on retourne
		// le même succès — pas d'enum d'emails par un attaquant.
		const user = getUserByEmail(rawEmail);
		if (user) {
			try {
				const link = createMagicLink(rawEmail);
				const verifyUrl = new URL('/auth/verify', url.origin);
				verifyUrl.searchParams.set('token', link.token);
				const next = url.searchParams.get('next');
				if (next && next !== '/') verifyUrl.searchParams.set('next', next);
				await sendMagicLink(rawEmail, verifyUrl.toString());
			} catch (e) {
				console.error('magic link send failed', e);
				// Volontaire : on cache l'erreur côté UX (toujours le même message),
				// les détails sont dans journalctl pour l'admin.
			}
		}

		return {
			magic: {
				sent: true,
				message: `Si ${rawEmail} est connu de votre galaxie, un lien de connexion vient d'être envoyé. Vérifiez vos mails (et les spams).`
			}
		};
	}
};
