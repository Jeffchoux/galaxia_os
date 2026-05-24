#!/usr/bin/env node
// Ad-hoc one-shot Playwright driver for the cockpit Galaxia.
//
// Réutilise l'install Playwright + Chromium déjà faite dans
// ops/browser-smoke (cf. SKILL.md "Prerequisites"). Pour le smoke
// complet de la surface publique, lancer plutôt ops/browser-smoke/test.mjs.
//
// Usage :
//   node driver.mjs <url> [css-selector-to-wait-for] [out-file.png]
//
// Exemples :
//   node driver.mjs http://127.0.0.1:3001/login 'input[type=password]'
//   node driver.mjs http://127.0.0.1:3001/login h1 /tmp/login.png
//
// - Suit les redirections (SvelteKit envoie 303 vers /login si non-auth).
// - Échoue avec code != 0 si le sélecteur n'apparaît pas en 15s.
// - Print les erreurs JS console (pageerror + console.error).
// - Screenshot écrit dans <out-file> (défaut /tmp/cockpit-shot.png).

import { createRequire } from 'node:module';
const require = createRequire('/home/galaxia/galaxia-project/ops/browser-smoke/');
const { chromium } = require('playwright');

const [, , urlArg, selArg, outArg] = process.argv;
if (!urlArg) {
	console.error('usage: node driver.mjs <url> [selector] [out.png]');
	process.exit(2);
}
const url = urlArg;
const selector = selArg ?? 'body';
const out = outArg ?? '/tmp/cockpit-shot.png';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console.error: ${m.text()}`));

let exit = 0;
try {
	const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
	const finalUrl = page.url();
	console.log(`status=${resp.status()} final=${finalUrl}`);
	await page.waitForSelector(selector, { timeout: 15000 });
	await page.screenshot({ path: out, fullPage: true });
	console.log(`shot=${out}`);
	if (errors.length) {
		console.log(`js-errors=${errors.length}`);
		errors.forEach((e) => console.log(`  ${e}`));
	}
} catch (e) {
	console.error(`FAIL: ${e.message}`);
	exit = 1;
} finally {
	await browser.close();
}
process.exit(exit);
