#!/usr/bin/env node
// Playwright driver for the cockpit Galaxia.
//
// Reuses the Playwright + Chromium install already done in ops/browser-smoke
// (cf. SKILL.md "Prerequisites"). For the full *public-surface* smoke, run
// ops/browser-smoke/test.mjs instead. This driver adds the bit that smoke
// deliberately skips: logging in (admin password) and driving the
// *authenticated* cockpit.
//
// Usage:
//   node driver.mjs <url> [css-selector-to-wait-for] [out.png]
//
// If COCKPIT_PASSWORD is set, the driver does the admin password login first
// (toggle "↓ Connexion administrateur" → fill → submit → wait for "/"), then
// navigates to <url> with the session cookie. Without it, it behaves exactly
// like before: a one-shot unauthenticated screenshot (you'll just land on
// /login for any guarded route).
//
// Env:
//   COCKPIT_PASSWORD   admin password — enables the authenticated flow
//   COCKPIT_LOGIN_URL  where the login form lives (default: derived from <url>'s origin + /login)
//
//   node driver.mjs http://127.0.0.1:3001/login 'input[type=email]'      # unauth
//   COCKPIT_PASSWORD=… node driver.mjs http://127.0.0.1:3099/ textarea /tmp/home.png  # authed
//
// - Follows redirects (SvelteKit sends 303 to /login when not authed).
// - Exits non-zero if the selector never appears (15s) or login fails.
// - Prints any JS console errors (pageerror + console.error).

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// Locate Playwright in ops/browser-smoke/node_modules by walking up from here
// (no hardcoded absolute path → survives the repo being checked out elsewhere,
// e.g. on a galaxie fille). Falls back to normal resolution / NODE_PATH.
function loadChromium() {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, 'ops/browser-smoke/node_modules/playwright'))) {
			return createRequire(join(dir, 'ops/browser-smoke/'))('playwright').chromium;
		}
		dir = dirname(dir);
	}
	return createRequire(import.meta.url)('playwright').chromium;
}
const chromium = loadChromium();

const [, , urlArg, selArg, outArg] = process.argv;
if (!urlArg) {
	console.error('usage: node driver.mjs <url> [selector] [out.png]');
	process.exit(2);
}
const url = urlArg;
const selector = selArg ?? 'body';
const out = outArg ?? '/tmp/cockpit-shot.png';
const password = process.env.COCKPIT_PASSWORD;
const loginUrl = process.env.COCKPIT_LOGIN_URL ?? new URL('/login', url).toString();

const browser = await chromium.launch({
	headless: true,
	args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console.error: ${m.text()}`));

let exit = 0;
try {
	if (password) {
		// Admin password form is hidden behind a toggle (primary auth = magic link).
		await page.goto(loginUrl, { waitUntil: 'networkidle' });
		await page.locator('button.toggle').click();
		const pw = page.locator('input[type=password][name=password]');
		await pw.waitFor({ state: 'visible', timeout: 3000 });
		await pw.fill(password);
		await Promise.all([
			page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 10000 }),
			page.locator('form[action="?/password"] button[type=submit]').click()
		]);
		console.log(`login=ok as admin (cookie set)`);
	}

	const resp = await page.goto(url, { waitUntil: 'networkidle' });
	console.log(`status=${resp.status()} final=${page.url()}`);
	await page.waitForSelector(selector, { timeout: 15000 });
	await page.screenshot({ path: out, fullPage: true });
	console.log(`shot=${out}`);
	if (errors.length) {
		console.log(`js-errors=${errors.length}`);
		errors.forEach((e) => console.log(`  ${e}`));
	}
} catch (e) {
	console.error(`FAIL: ${e.message}`);
	await page.screenshot({ path: out.replace(/\.png$/, '') + '-crash.png' }).catch(() => {});
	exit = 1;
} finally {
	await browser.close();
}
process.exit(exit);
