// Smoke test du cockpit Galaxia depuis un Chromium headless réel (Playwright).
//
// Ce que ça couvre :
//   - root redirige vers /login (auth gate)
//   - la page /login render correctement (title, h1, input email primary,
//     toggle admin qui révèle l'input password)
//   - routes protégées (/documents, /briefs, /api/conversations) renvoient au login
//   - /api/tts répond (et exige bien l'auth quand le cookie est absent)
//   - assets statiques (favicon, manifest) sont servis
//   - 0 erreur JS console au chargement
//
// Ce que ça ne couvre PAS (besoin du cookie session) :
//   - le chat streaming, le drag-drop docs, le wake word / VAD, la voix end-to-end
//   - les onglets Documents et Briefs en mode authentifié
//
// Usage :
//   BASE_URL=https://app.galaxia-os.com node test.mjs        # défaut : prod
//   BASE_URL=http://127.0.0.1:3000 node test.mjs             # cockpit local

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'https://app.galaxia-os.com';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
function ok(msg, extra) {
	pass++;
	console.log(`  \x1b[32m✓\x1b[0m ${msg}${extra ? ` — ${extra}` : ''}`);
}
function ko(msg, extra) {
	fail++;
	console.error(`  \x1b[31m✗\x1b[0m ${msg}${extra ? ` — ${extra}` : ''}`);
}
function info(msg) {
	console.log(`\x1b[2m·\x1b[0m ${msg}`);
}

console.log(`\n=== Galaxia cockpit — browser smoke (${BASE}) ===\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
	viewport: { width: 1280, height: 800 },
	userAgent: 'Mozilla/5.0 (Galaxia browser smoke test)'
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`console.error: ${m.text()}`));

try {
	// ─── 1. Root redirige vers /login ───
	const t0 = Date.now();
	const home = await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
	const dt = Date.now() - t0;
	const finalPath = new URL(page.url()).pathname + new URL(page.url()).search;
	if (home.status() === 200 && finalPath.startsWith('/login')) {
		ok('GET / → 200 + redirige vers /login', `${dt}ms, dest=${finalPath}`);
	} else {
		ko('GET /', `status=${home.status()} dest=${finalPath}`);
	}
	await page.screenshot({ path: `${OUT}/01-login.png`, fullPage: true });

	// ─── 2. Login page render OK ───
	// Depuis Sprint 2, le formulaire primaire est le magic link (email).
	// Le password admin est caché derrière un toggle "↓ Connexion administrateur".
	const title = await page.title();
	const h1 = await page.locator('h1').first().textContent().catch(() => null);
	const hasEmailField = (await page.locator('input[type=email]').count()) > 0;
	const hasSubmit = (await page.locator('button[type=submit]').count()) > 0;
	const adminToggle = page.locator('button.toggle');
	const hasAdminToggle = (await adminToggle.count()) > 0;
	if (title.includes('Galaxia')) ok('Login title contient "Galaxia"', title);
	else ko('Login title', `got "${title}"`);
	if (h1 && h1.includes('Galaxia')) ok('Login h1 contient "Galaxia"', h1);
	else ko('Login h1', `got "${h1}"`);
	if (hasEmailField) ok('Champ <input type=email> (magic link) présent');
	else ko('Champ email absent');
	if (hasSubmit) ok('Bouton <button type=submit> présent (magic link form)');
	else ko('Bouton submit absent');
	if (hasAdminToggle) ok('Toggle "↓ Connexion administrateur" présent');
	else ko('Toggle admin absent');

	// Le password doit être caché par défaut, révélé après clic sur le toggle
	const pwCountBefore = await page.locator('input[type=password]').count();
	if (pwCountBefore === 0) ok('Champ password caché par défaut (auth primaire = magic link)');
	else ko('Champ password visible sans clic sur toggle', `count=${pwCountBefore}`);

	if (hasAdminToggle) {
		await adminToggle.click();
		// Attend que l'input password apparaisse (Svelte5 réactivité quasi instantanée)
		await page.locator('input[type=password]').first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
		const pwCountAfter = await page.locator('input[type=password]').count();
		if (pwCountAfter > 0) ok('Champ password révélé après clic sur toggle admin');
		else ko('Champ password absent après clic sur toggle', `count=${pwCountAfter}`);
	}

	// ─── 3. Routes protégées renvoient au login ───
	const guarded = ['/documents', '/briefs', '/api/conversations'];
	for (const p of guarded) {
		const r = await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
		const dest = new URL(page.url()).pathname;
		if (dest.startsWith('/login')) ok(`GET ${p} → ${r.status()} → /login`);
		else ko(`GET ${p}`, `dest=${dest} (devrait être /login)`);
	}

	// ─── 4. /api/tts sans cookie : doit pas servir d'audio ───
	const ttsResp = await ctx.request.post(`${BASE}/api/tts`, {
		data: { text: 'Bonjour Jeff, ceci est un test de la voix Galaxia.' },
		failOnStatusCode: false
	});
	const ttsType = ttsResp.headers()['content-type'] ?? '';
	if (!ttsType.startsWith('audio/')) {
		ok('POST /api/tts sans cookie : pas d\'audio servi (auth gate OK)', `status=${ttsResp.status()} ct=${ttsType}`);
	} else {
		ko('POST /api/tts a servi de l\'audio sans auth', `ct=${ttsType}`);
	}

	// ─── 4b. /api/realtime/session sans cookie : doit refuser (D8) ───
	// Le hook auth global redirige les routes protégées vers /login (303).
	// On désactive le follow-redirect pour vérifier qu'on ne mint PAS de
	// client_secret (réponse jamais en JSON application/json côté OpenAI).
	const rtSess = await ctx.request.post(`${BASE}/api/realtime/session`, {
		failOnStatusCode: false,
		maxRedirects: 0
	});
	const rtSessOk =
		rtSess.status() === 401 ||
		rtSess.status() === 303 ||
		(rtSess.status() >= 300 && rtSess.status() < 400);
	const rtSessCt = rtSess.headers()['content-type'] ?? '';
	if (rtSessOk && !rtSessCt.startsWith('application/json')) {
		ok(`POST /api/realtime/session sans cookie → ${rtSess.status()} (auth gate OK)`);
	} else {
		ko('POST /api/realtime/session sans cookie', `status=${rtSess.status()} ct=${rtSessCt}`);
	}

	// ─── 4c. /api/realtime/usage sans cookie : doit refuser (D8) ───
	const rtUsage = await ctx.request.post(`${BASE}/api/realtime/usage`, {
		data: { input_audio_tokens: 0, output_audio_tokens: 0 },
		failOnStatusCode: false,
		maxRedirects: 0
	});
	const rtUsageOk =
		rtUsage.status() === 401 ||
		rtUsage.status() === 303 ||
		(rtUsage.status() >= 300 && rtUsage.status() < 400);
	if (rtUsageOk) {
		ok(`POST /api/realtime/usage sans cookie → ${rtUsage.status()} (auth gate OK)`);
	} else {
		ko('POST /api/realtime/usage sans cookie', `status=${rtUsage.status()}`);
	}

	// ─── 5. Assets statiques ───
	for (const a of ['/favicon.ico', '/manifest.webmanifest']) {
		const r = await ctx.request.get(`${BASE}${a}`, { failOnStatusCode: false });
		if (r.status() === 200) ok(`GET ${a} → 200`);
		else ko(`GET ${a}`, `status=${r.status()}`);
	}

	// ─── 6. Erreurs JS console ───
	await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
	if (consoleErrors.length === 0) ok('0 erreur JS au chargement du login');
	else {
		ko(`${consoleErrors.length} erreur(s) JS au chargement`);
		consoleErrors.forEach((e) => info(`  ${e}`));
	}

	await page.screenshot({ path: `${OUT}/02-login-final.png`, fullPage: true });
} finally {
	await browser.close();
}

console.log(`\n=== Résultat : \x1b[32m${pass} passed\x1b[0m, ${fail > 0 ? `\x1b[31m${fail} failed\x1b[0m` : '0 failed'} ===`);
console.log(`Screenshots → ${OUT}/\n`);

process.exit(fail === 0 ? 0 : 1);
