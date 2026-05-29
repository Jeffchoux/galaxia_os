import {
	readdirSync,
	readFileSync,
	realpathSync,
	statSync
} from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { getCodeRoot } from './env';

// Vue Code (Galaxia 2.0 WS4) — lecture seule de l'arborescence du repo que
// l'agent coder édite via MCP. Toutes les fonctions sont scopées sous la racine
// `getCodeRoot()` et défendent contre la traversée (symlinks compris) via realpath.

export interface CodeNode {
	name: string;
	path: string; // chemin relatif à la racine (séparateur '/')
	type: 'dir' | 'file';
	children?: CodeNode[];
}

// Dossiers volumineux / non pertinents : jamais listés ni traversés.
const IGNORE = new Set([
	'node_modules',
	'.git',
	'build',
	'.svelte-kit',
	'dist',
	'data',
	'.cache',
	'venv',
	'.venv',
	'__pycache__',
	'.turbo'
]);

const MAX_NODES = 4000; // garde-fou contre un payload de tree démesuré
const MAX_FILE_BYTES = 512 * 1024; // 512 KiB : au-delà on ne rend pas dans le browser

// realpath de la racine, calculé à chaque appel (la racine est fixe en prod
// mais on évite tout cache qui survivrait à un changement d'env en dev).
function rootReal(): string {
	return realpathSync(getCodeRoot());
}

// Un chemin dont l'un des segments est ignoré (node_modules, .git, build…) est
// hors-périmètre de la vue Code, même en accès direct : on aligne la lecture sur
// ce que le tree expose, pour ne pas servir .git, node_modules ou data.
function isIgnoredPath(relPath: string): boolean {
	return relPath
		.split(/[\\/]/)
		.some((seg) => seg === '' || seg.startsWith('.git') || IGNORE.has(seg));
}

// Résout un chemin relatif sous la racine et vérifie qu'il n'en sort pas, même
// via un symlink. Renvoie le chemin absolu canonique, ou null si hors-racine.
function safeResolve(root: string, relPath: string): string | null {
	const abs = resolve(root, relPath);
	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		return null; // n'existe pas
	}
	if (real !== root && !real.startsWith(root + sep)) return null;
	return real;
}

function walk(absDir: string, relDir: string, counter: { n: number }): CodeNode[] {
	let entries;
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const dirs: CodeNode[] = [];
	const files: CodeNode[] = [];
	for (const e of entries) {
		if (e.name.startsWith('.git') || IGNORE.has(e.name)) continue;
		if (counter.n >= MAX_NODES) break;
		counter.n++;
		const rel = relDir ? `${relDir}/${e.name}` : e.name;
		if (e.isDirectory()) {
			dirs.push({
				name: e.name,
				path: rel,
				type: 'dir',
				children: walk(join(absDir, e.name), rel, counter)
			});
		} else if (e.isFile()) {
			files.push({ name: e.name, path: rel, type: 'file' });
		}
	}
	// Dossiers d'abord, puis fichiers ; chaque groupe trié alphabétiquement.
	dirs.sort((a, b) => a.name.localeCompare(b.name));
	files.sort((a, b) => a.name.localeCompare(b.name));
	return [...dirs, ...files];
}

export interface CodeTree {
	available: boolean;
	root: string; // basename de la racine, pour affichage
	nodes: CodeNode[];
	truncated: boolean;
}

export function buildTree(): CodeTree {
	let root: string;
	try {
		root = rootReal();
	} catch {
		return { available: false, root: '', nodes: [], truncated: false };
	}
	const counter = { n: 0 };
	const nodes = walk(root, '', counter);
	return {
		available: true,
		root: root.split(sep).pop() || root,
		nodes,
		truncated: counter.n >= MAX_NODES
	};
}

export interface CodeFile {
	path: string;
	content: string;
	size: number;
	lines: number;
}

export type CodeFileError = { error: string };

export function readCodeFile(relPath: string): CodeFile | CodeFileError {
	let root: string;
	try {
		root = rootReal();
	} catch {
		return { error: 'racine code indisponible' };
	}
	if (isIgnoredPath(relPath)) return { error: 'chemin hors périmètre' };
	const abs = safeResolve(root, relPath);
	if (!abs) return { error: 'chemin hors périmètre ou introuvable' };
	const st = statSync(abs);
	if (!st.isFile()) return { error: 'pas un fichier' };
	if (st.size > MAX_FILE_BYTES) {
		return { error: `fichier trop volumineux (${Math.round(st.size / 1024)} Kio, max 512 Kio)` };
	}
	const buf = readFileSync(abs);
	// Détection binaire grossière : un octet nul dans les 8 premiers Kio.
	const probe = buf.subarray(0, 8192);
	if (probe.includes(0)) return { error: 'fichier binaire — non affichable' };
	const content = buf.toString('utf8');
	return {
		path: relPath.split(sep).join('/'),
		content,
		size: st.size,
		lines: content.length === 0 ? 0 : content.split('\n').length
	};
}
