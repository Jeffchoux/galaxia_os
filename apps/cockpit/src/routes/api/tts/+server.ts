import { error, type RequestHandler } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPiperBin, getPiperDaemonUrl, getPiperModel } from '$lib/server/env';

const MAX_TEXT = 2000;

async function synthesizeViaDaemon(text: string): Promise<Buffer | null> {
	const url = getPiperDaemonUrl();
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text })
		});
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		return buf;
	} catch {
		return null;
	}
}

async function synthesizeViaSpawn(text: string): Promise<Buffer> {
	const bin = getPiperBin();
	const model = getPiperModel();
	if (!existsSync(bin) || !existsSync(model)) {
		throw error(503, 'Piper TTS non installé sur ce serveur');
	}
	const dir = await mkdtemp(join(tmpdir(), 'piper-'));
	const outFile = join(dir, 'out.wav');
	try {
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(bin, ['-m', model, '-f', outFile], {
				stdio: ['pipe', 'pipe', 'pipe']
			});
			let stderr = '';
			proc.stderr.on('data', (b) => (stderr += b.toString()));
			proc.on('error', reject);
			proc.on('exit', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`piper exit ${code} : ${stderr.slice(0, 500)}`));
			});
			proc.stdin.write(text);
			proc.stdin.end();
		});
		return await readFile(outFile);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const body = (await request.json()) as { text?: string };
	const text = (body.text ?? '').trim();
	if (!text) throw error(400, 'empty text');
	if (text.length > MAX_TEXT) throw error(400, 'text too long');

	// 1. Daemon HTTP (rapide, modèle pré-chargé) → ~200-500ms/phrase
	// 2. Fallback spawn (lent mais sans dépendance) → ~2s/phrase
	// 3. Si rien ne marche → 503, le client retombe sur le TTS browser
	let audio = await synthesizeViaDaemon(text);
	if (!audio) {
		audio = await synthesizeViaSpawn(text);
	}

	return new Response(new Uint8Array(audio), {
		headers: {
			'content-type': 'audio/wav',
			'content-length': String(audio.length),
			'cache-control': 'no-store'
		}
	});
};
