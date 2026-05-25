import { env } from '$env/dynamic/private';

function required(name: string): string {
	const v = env[name];
	if (!v) throw new Error(`Missing env var ${name}`);
	return v;
}

// Lazy : ne lit l'env qu'à l'appel, jamais à l'import. Évite de casser `vite build`.
export const getAnthropicKey = () => required('ANTHROPIC_API_KEY');
export const getJeffPassHash = () => required('JEFF_PASS_HASH');
export const getSessionSecret = () => required('SESSION_SECRET');
// Email de l'utilisateur admin (Jeff). Provisionné en base au 1er démarrage si
// absent, et toutes les conversations existantes lui sont rattachées par migration.
// Pré-requis pour ouvrir le cockpit à plus d'un utilisateur (Sprint 2 multi-user).
export const getAdminEmail = () => required('ADMIN_EMAIL');
export const getModel = () => env.COCKPIT_MODEL ?? 'claude-opus-4-7';
export const getDbPath = () => env.COCKPIT_DB_PATH ?? './data/cockpit.db';
// Briefs : par défaut on lit ceux produits par le pipeline digest de la galaxie
// mère (côté OpenJeff). Pour les filles PME, à pointer vers leur propre dir.
export const getBriefsDir = () =>
	env.COCKPIT_BRIEFS_DIR ?? '/home/galaxia/.claude/galaxia/briefs';
// Piper TTS local (français). Le V2 utilise un daemon HTTP résident
// (galaxia-piper.service) — ~5x plus rapide qu'un spawn par requête.
// Si l'URL est down ou le binaire absent, /api/tts renvoie 503 et le
// client retombe sur le TTS browser natif.
export const getPiperDaemonUrl = () =>
	env.PIPER_DAEMON_URL ?? 'http://127.0.0.1:5500/';
export const getPiperBin = () =>
	env.PIPER_BIN ?? '/home/galaxia/.claude/galaxia/venv/bin/piper';
export const getPiperModel = () =>
	env.PIPER_MODEL ?? '/opt/galaxia/piper-voices/fr_FR-siwis-medium.onnx';

// Kyutai Pocket TTS (Sprint 3 § A.2, cf. docs/DECISIONS.md § D6).
// Daemon FastAPI lancé via galaxia-kyutai-tts.service. Modèle `french_24l`
// quantifié int8 → ~2× plus rapide que temps réel sur ce VPS CPU-only,
// streaming chunked WAV. Si la var n'est pas définie ou le daemon down,
// /api/tts retombe transparent sur Piper.
//
// L'URL pointe sur la racine ; l'endpoint est `${URL}/tts` (POST multipart).
export const getKyutaiTtsUrl = () =>
	env.KYUTAI_TTS_URL ?? 'http://127.0.0.1:5501';

// Mail provider pour les magic links (Sprint 2 PR-B). Default : `console`
// (log dans journalctl) — safe en dev et CI sans clé Brevo. En prod PME,
// basculer sur `brevo` une fois BREVO_API_KEY posée et MAIL_FROM validé.
export const getMailProvider = (): 'brevo' | 'console' => {
	const v = env.MAIL_PROVIDER ?? 'console';
	if (v === 'brevo' || v === 'console') return v;
	throw new Error(`MAIL_PROVIDER invalide : "${v}" (attendu : brevo | console)`);
};
export const getBrevoApiKey = () => required('BREVO_API_KEY');
export const getMailFrom = () => env.MAIL_FROM ?? 'no-reply@galaxia-os.com';
export const getMailFromName = () => env.MAIL_FROM_NAME ?? 'Galaxia';
