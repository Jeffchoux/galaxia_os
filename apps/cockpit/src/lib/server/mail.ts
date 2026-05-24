// Abstraction d'envoi de mail transactionnel. L'app appelle sendMagicLink()
// sans connaître le provider concret. Le choix (Brevo / Console) se fait via
// MAIL_PROVIDER en env. Sprint 2 — préparation à l'auth par magic link (PR-C).
//
// Aucun appel réseau au boot : le provider est lazy-init à la 1re utilisation.
// Si MAIL_PROVIDER=brevo mais BREVO_API_KEY manque, on échoue au send pas au boot
// (ça permet à la CI smoke et au dev local de tourner sans clé Brevo).

import { getBrevoApiKey, getMailFrom, getMailFromName, getMailProvider } from './env';

export interface MailProvider {
	name: 'brevo' | 'console';
	sendMagicLink(to: string, link: string): Promise<void>;
}

// ─── Console provider ──────────────────────────────────────────────────────
// Utilisé en dev local et en CI : log le magic link au lieu de l'envoyer.
// L'admin qui développe peut cliquer sur le lien depuis les logs `journalctl`.

class ConsoleProvider implements MailProvider {
	readonly name = 'console';
	async sendMagicLink(to: string, link: string): Promise<void> {
		console.log(`[mail/console] magic link pour ${to} : ${link}`);
	}
}

// ─── Brevo provider ────────────────────────────────────────────────────────
// API HTTP transactionnelle : POST https://api.brevo.com/v3/smtp/email
// Doc : https://developers.brevo.com/reference/sendtransacemail
//
// Plan free Brevo = 300 emails/jour à vie, suffisant pour un pilote PME où
// le pic d'envoi = un magic link par login utilisateur par jour.

class BrevoProvider implements MailProvider {
	readonly name = 'brevo';
	async sendMagicLink(to: string, link: string): Promise<void> {
		const apiKey = getBrevoApiKey();
		const from = getMailFrom();
		const fromName = getMailFromName();

		const subject = 'Connexion à votre galaxie';
		const htmlContent = renderMagicLinkHtml(link);
		const textContent = renderMagicLinkText(link);

		const res = await fetch('https://api.brevo.com/v3/smtp/email', {
			method: 'POST',
			headers: {
				'api-key': apiKey,
				'content-type': 'application/json',
				accept: 'application/json'
			},
			body: JSON.stringify({
				sender: { email: from, name: fromName },
				to: [{ email: to }],
				subject,
				htmlContent,
				textContent
			})
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`Brevo HTTP ${res.status} : ${body.slice(0, 200)}`);
		}
	}
}

// Templates très simples — le mail doit passer les filtres anti-spam et rester
// lisible dans tous les clients. Pas de tracking pixel, pas de CSS externe.

function renderMagicLinkHtml(link: string): string {
	const safe = link.replace(/[<>"]/g, '');
	return `<!doctype html><html lang="fr"><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:520px;margin:0 auto;padding:2rem 1rem;">
<h2 style="margin:0 0 0.5rem;font-weight:600;">Galaxia</h2>
<p>Quelqu'un (vous, on l'espère) vient de demander un lien de connexion pour votre galaxie.</p>
<p style="margin:1.5rem 0;"><a href="${safe}" style="display:inline-block;padding:0.7rem 1.2rem;background:#7c3aed;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Se connecter</a></p>
<p style="color:#666;font-size:0.9rem;">Ce lien est valable 15 minutes et ne peut être utilisé qu'une fois.</p>
<p style="color:#999;font-size:0.85rem;margin-top:2rem;">Si vous n'avez rien demandé, vous pouvez ignorer ce mail. Aucun compte n'a été créé sans votre action.</p>
</body></html>`;
}

function renderMagicLinkText(link: string): string {
	return [
		'Galaxia — connexion',
		'',
		"Quelqu'un (vous, on l'espère) vient de demander un lien de connexion pour votre galaxie.",
		'',
		'Lien (valable 15 minutes, à usage unique) :',
		link,
		'',
		"Si vous n'avez rien demandé, ignorez ce mail — aucun compte n'a été créé sans votre action."
	].join('\n');
}

// ─── Sélection lazy du provider ────────────────────────────────────────────

let _provider: MailProvider | null = null;

export function getMailer(): MailProvider {
	if (_provider) return _provider;
	const choice = getMailProvider();
	if (choice === 'brevo') _provider = new BrevoProvider();
	else if (choice === 'console') _provider = new ConsoleProvider();
	else throw new Error(`MAIL_PROVIDER invalide : "${choice}" (attendu : brevo | console)`);
	return _provider;
}

// Façade : ce que les routes appelleront. Garde le provider invisible.
export function sendMagicLink(to: string, link: string): Promise<void> {
	return getMailer().sendMagicLink(to, link);
}
