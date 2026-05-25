import { error, type RequestHandler } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	getKyutaiTtsUrl,
	getPiperBin,
	getPiperDaemonUrl,
	getPiperModel
} from '$lib/server/env';

const MAX_TEXT = 2000;
type Backend = 'piper' | 'kyutai';

async function synthesizeViaPiperDaemon(text: string): Promise<Buffer | null> {
	const url = getPiperDaemonUrl();
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text })
		});
		if (!res.ok) return null;
		return Buffer.from(await res.arrayBuffer());
	} catch {
		return null;
	}
}

async function synthesizeViaKyutai(text: string): Promise<Buffer | null> {
	// Pocket TTS expose POST /tts en multipart/form-data — fetch construit
	// le bon Content-Type avec boundary tout seul depuis le FormData.
	const url = `${getKyutaiTtsUrl().replace(/\/$/, '')}/tts`;
	const form = new FormData();
	form.set('text', text);
	try {
		const res = await fetch(url, { method: 'POST', body: form });
		if (!res.ok) return null;
		return Buffer.from(await res.arrayBuffer());
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

	const body = (await request.json()) as { text?: string; backend?: Backend };
	const text = (body.text ?? '').trim();
	const requestedBackend: Backend = body.backend === 'kyutai' ? 'kyutai' : 'piper';
	if (!text) throw error(400, 'empty text');
	if (text.length > MAX_TEXT) throw error(400, 'text too long');

	// Cascade : on tente le backend demandé, puis on retombe sur Piper, puis
	// sur le spawn local. Si tout échoue, 503 → le client repasse en TTS browser.
	//
	// - kyutai : daemon Pocket TTS port 5501, modèle french_24l int8, streaming
	//   chunked → RTF ≈ 0.5 sur ce VPS CPU (~2× plus rapide que temps réel)
	// - piper  : daemon HTTP port 5500, voix fr_FR-siwis-medium → ~200-500ms/phrase
	// - spawn  : binaire piper en CLI (fallback de secours) → ~2s/phrase
	let audio: Buffer | null = null;
	if (requestedBackend === 'kyutai') {
		audio = await synthesizeViaKyutai(text);
	}
	if (!audio) {
		audio = await synthesizeViaPiperDaemon(text);
	}
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
