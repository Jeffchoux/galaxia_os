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
// Décision D3 : Sonnet par défaut (rapport qualité/coût optimal pour une PME).
// Opus reste disponible via COCKPIT_MODEL=claude-opus-4-8 dans le .env.
export const getModel = () => env.COCKPIT_MODEL ?? 'claude-sonnet-4-6';
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

// Whisper STT (Sprint 3 § A.3, cf. docs/DECISIONS.md § D7).
// Daemon FastAPI (galaxia-whisper.service) qui tourne faster-whisper
// large-v3-turbo en int8 sur CPU. Endpoint `${URL}/transcribe` multipart.
// Si la var est vide ou le daemon down, /api/stt renvoie 503 → le client
// retombe sur Web Speech (SpeechRecognition natif navigateur).
export const getWhisperUrl = () =>
	env.WHISPER_URL ?? 'http://127.0.0.1:5502';

// OpenAI Realtime API (Sprint 3 § D8, cf. docs/DECISIONS.md). Mode speech-to-
// speech bout-en-bout. La clé doit avoir l'accès Realtime activé. Si la var
// est absente, /api/realtime/session renvoie 503 et le client n'expose pas
// l'option 'realtime' dans le toggle voix.
export const getOpenAIKey = () => env.OPENAI_API_KEY ?? '';
export const getOpenAIRealtimeModel = () =>
	env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime';
export const getOpenAIRealtimeVoice = () =>
	env.OPENAI_REALTIME_VOICE ?? 'alloy';

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
