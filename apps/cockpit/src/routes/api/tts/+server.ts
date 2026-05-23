import { error, type RequestHandler } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPiperBin, getPiperModel } from '$lib/server/env';

const MAX_TEXT = 2000;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const body = (await request.json()) as { text?: string };
	const text = (body.text ?? '').trim();
	if (!text) throw error(400, 'empty text');
	if (text.length > MAX_TEXT) throw error(400, 'text too long');

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

		const audio = await readFile(outFile);
		return new Response(audio, {
			headers: {
				'content-type': 'audio/wav',
				'content-length': String(audio.length),
				'cache-control': 'no-store'
			}
		});
	} finally {
		// cleanup
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
};
