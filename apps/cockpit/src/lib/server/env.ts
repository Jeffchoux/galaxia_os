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
