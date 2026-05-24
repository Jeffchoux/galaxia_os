#!/usr/bin/env node
// Copie les assets statiques de @ricky0123/vad-web + onnxruntime-web vers
// static/vad/. Lancé en `postinstall` pour éviter de committer ~80MB de
// WebAssembly et de modèles ONNX dans git — ils sont récupérés via npm.
//
// Les noms de fichiers et leur chemin dans /vad/ sont attendus par le client
// (cf. baseAssetPath/onnxWASMBasePath dans apps/cockpit/src/routes/+page.svelte).
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cockpitRoot = dirname(here);
const dest = join(cockpitRoot, 'static', 'vad');
const nm = join(cockpitRoot, 'node_modules');

const files = [
	['@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'silero_vad_v5.onnx'],
	['@ricky0123/vad-web/dist/silero_vad_legacy.onnx', 'silero_vad_legacy.onnx'],
	['@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', 'vad.worklet.bundle.min.js'],
	['onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
	['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
	['onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.wasm'],
	['onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm', 'ort-wasm-simd-threaded.jspi.wasm'],
	['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.wasm']
];

await mkdir(dest, { recursive: true });
for (const [src, name] of files) {
	await copyFile(join(nm, src), join(dest, name));
}
console.log(`[vad] copied ${files.length} assets → static/vad/`);
