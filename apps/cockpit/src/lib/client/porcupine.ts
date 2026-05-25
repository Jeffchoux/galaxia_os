// Wake word "Hey Galaxia" via Picovoice Porcupine WASM (Sprint 3 — Volet A.1).
//
// Mode dogfooding-mère (cf. docs/DECISIONS.md § D6) : la galaxie mère utilise
// un access key Picovoice perso (free tier) + un fichier .ppn custom entraîné
// sur la console. Sans ces deux artefacts, le module reste inerte et le code
// appelant retombe sur le filtre regex actuel (cf. WAKE_RE dans +page.svelte).
//
// Le scaffold est volontairement minimal : pas d'UI nouvelle, pas de dépendance
// runtime ajoutée au flux STT existant. Quand `initPorcupine` résout un handle,
// les frames mic sont consommées par Porcupine en arrière-plan, et `onWake` est
// appelé à chaque détection. Le composant parent choisit alors quoi faire
// (typiquement : démarrer la SpeechRecognition pour capter la phrase qui suit).

import type { PorcupineWorker } from '@picovoice/porcupine-web';

export type WakeConfig = {
	accessKey: string;
	keywordPath: string; // URL relative au static/, ex. "/wake/hey_galaxia_fr.ppn"
	keywordLabel?: string; // libellé affiché dans les logs (défaut: "Hey Galaxia")
};

export type WakeHandle = {
	destroy: () => Promise<void>;
};

/**
 * Initialise le détecteur acoustique Porcupine + le worker mic.
 *
 * Doit être appelé côté navigateur uniquement (utilise WebAudio + WASM).
 * Le caller est responsable de gérer la permission micro AVANT cet appel —
 * Porcupine échoue silencieusement si l'utilisateur refuse `getUserMedia`.
 *
 * @returns un handle dont `destroy()` libère le worker + relâche le micro,
 *          ou `null` si la config est incomplète / le navigateur incompatible.
 */
export async function initPorcupine(
	config: WakeConfig,
	onWake: () => void,
): Promise<WakeHandle | null> {
	if (typeof window === 'undefined') return null;
	if (!config.accessKey || !config.keywordPath) return null;

	const { PorcupineWorker } = await import('@picovoice/porcupine-web');
	const { WebVoiceProcessor } = await import('@picovoice/web-voice-processor');

	let worker: PorcupineWorker | null = null;
	try {
		worker = await PorcupineWorker.create(
			config.accessKey,
			[
				{
					publicPath: config.keywordPath,
					label: config.keywordLabel ?? 'Hey Galaxia',
				},
			],
			(detection) => {
				// Porcupine renvoie {label, index} — un seul keyword côté V1, label suffit
				console.info('[porcupine] wake detected:', detection.label);
				onWake();
			},
			{ publicPath: '/wake/porcupine_params_fr.pv' },
		);
		await WebVoiceProcessor.subscribe(worker);
	} catch (err) {
		console.warn('[porcupine] init failed, falling back to regex wake:', err);
		if (worker) try { worker.terminate(); } catch { /* ignore */ }
		return null;
	}

	return {
		destroy: async () => {
			if (worker) {
				await WebVoiceProcessor.unsubscribe(worker).catch(() => {});
				try { worker.terminate(); } catch { /* ignore */ }
				worker = null;
			}
		},
	};
}
