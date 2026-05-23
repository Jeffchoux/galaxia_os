// Smoke test du cockpit Galaxia depuis un Chromium headless réel (Playwright).
//
// Ce que ça couvre :
//   - root redirige vers /login (auth gate)
//   - la page /login render correctement (title, h1, input password, submit)
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
	const title = await page.title();
	const h1 = await page.locator('h1').first().textContent().catch(() => null);
	const hasPwField = (await page.locator('input[type=password]').count()) > 0;
	const hasSubmit = (await page.locator('button[type=submit]').count()) > 0;
	if (title.includes('Galaxia')) ok('Login title contient "Galaxia"', title);
	else ko('Login title', `got "${title}"`);
	if (h1 && h1.includes('Galaxia')) ok('Login h1 contient "Galaxia"', h1);
	else ko('Login h1', `got "${h1}"`);
	if (hasPwField) ok('Champ <input type=password> présent');
	else ko('Champ password absent');
	if (hasSubmit) ok('Bouton <button type=submit> présent');
	else ko('Bouton submit absent');

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
