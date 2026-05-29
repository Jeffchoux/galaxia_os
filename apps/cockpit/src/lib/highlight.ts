// Coloration syntaxique légère, zéro dépendance, isomorphe (serveur + client).
// Objectif : lisibilité « façon Claude Code » sans embarquer highlight.js/shiki,
// dans la lignée du choix « zéro nouvelle dép » du projet. Couvre les langages
// présents dans le repo ; les fichiers markup (svelte/html) ont un mode allégé.
//
// Sécurité : la sortie est de l'HTML. Tout le texte source est échappé AVANT
// insertion ; les <span> n'enrobent que des classes statiques. Pas d'injection
// possible depuis le contenu du fichier.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function esc(s: string): string {
	return s.replace(/[&<>]/g, (c) => ESC[c] ?? c);
}

type Mode = 'js' | 'css' | 'json' | 'py' | 'sh' | 'markup' | 'plain';

const EXT_MODE: Record<string, Mode> = {
	ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
	json: 'json', json5: 'js',
	css: 'css', scss: 'css', less: 'css',
	py: 'py',
	sh: 'sh', bash: 'sh', zsh: 'sh',
	svelte: 'markup', html: 'markup', htm: 'markup', xml: 'markup', vue: 'markup',
	// markdown/texte : pas de tokenizer (rendu brut échappé)
	md: 'plain', markdown: 'plain', txt: 'plain', yml: 'plain', yaml: 'plain'
};

const JS_KW = new Set([
	'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
	'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
	'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
	'import', 'in', 'instanceof', 'interface', 'is', 'keyof', 'let', 'namespace',
	'new', 'of', 'package', 'private', 'protected', 'public', 'readonly', 'return',
	'satisfies', 'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'type',
	'typeof', 'var', 'void', 'while', 'yield'
]);
const JS_LIT = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const JS_TYPE = new Set([
	'string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'unknown', 'any',
	'never', 'Array', 'Promise', 'Record', 'Map', 'Set', 'Date', 'RegExp', 'Error',
	'Buffer'
]);
const PY_KW = new Set([
	'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
	'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
	'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
	'return', 'try', 'while', 'with', 'yield', 'None', 'True', 'False', 'self'
]);
const SH_KW = new Set([
	'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'do', 'done', 'case',
	'esac', 'function', 'return', 'in', 'local', 'export', 'echo', 'set', 'cd'
]);

type Rule = { re: string; cls: string };

// Chaque pattern doit n'utiliser QUE des groupes non-capturants (?:...) :
// l'algo s'appuie sur un groupe capturant par règle pour savoir laquelle a matché.
const RULES: Record<Exclude<Mode, 'plain'>, Rule[]> = {
	js: [
		{ re: '/\\*(?:[^*]|\\*(?!/))*\\*/', cls: 'comment' },
		{ re: '//[^\\n]*', cls: 'comment' },
		{ re: '`(?:\\\\.|[^`\\\\])*`', cls: 'string' },
		{ re: '"(?:\\\\.|[^"\\\\\\n])*"', cls: 'string' },
		{ re: "'(?:\\\\.|[^'\\\\\\n])*'", cls: 'string' },
		{ re: '\\b(?:0[xX][\\da-fA-F]+|\\d(?:[\\d_]*\\.?[\\d_]*)?(?:[eE][+-]?\\d+)?)\\b', cls: 'number' },
		{ re: '[A-Za-z_$][\\w$]*', cls: 'ident-js' }
	],
	css: [
		{ re: '/\\*(?:[^*]|\\*(?!/))*\\*/', cls: 'comment' },
		{ re: '"(?:[^"\\n]*)"', cls: 'string' },
		{ re: "'(?:[^'\\n]*)'", cls: 'string' },
		{ re: '#[0-9a-fA-F]{3,8}\\b', cls: 'number' },
		{ re: '\\b\\d[\\d.]*(?:px|rem|em|%|vh|vw|vmin|vmax|fr|s|ms|deg|pt)?\\b', cls: 'number' },
		{ re: '@[A-Za-z-]+', cls: 'keyword' },
		{ re: '--[A-Za-z0-9-]+', cls: 'type' }
	],
	json: [
		{ re: '"(?:\\\\.|[^"\\\\])*"', cls: 'string' },
		{ re: '\\b(?:true|false|null)\\b', cls: 'keyword' },
		{ re: '-?\\b\\d(?:[\\d.]*)(?:[eE][+-]?\\d+)?\\b', cls: 'number' }
	],
	py: [
		{ re: '#[^\\n]*', cls: 'comment' },
		{ re: '"""[\\s\\S]*?"""', cls: 'string' },
		{ re: "'''[\\s\\S]*?'''", cls: 'string' },
		{ re: '"(?:\\\\.|[^"\\\\\\n])*"', cls: 'string' },
		{ re: "'(?:\\\\.|[^'\\\\\\n])*'", cls: 'string' },
		{ re: '\\b\\d[\\d_.]*\\b', cls: 'number' },
		{ re: '[A-Za-z_][\\w]*', cls: 'ident-py' }
	],
	sh: [
		{ re: '#[^\\n]*', cls: 'comment' },
		{ re: '"(?:\\\\.|[^"\\\\])*"', cls: 'string' },
		{ re: "'[^']*'", cls: 'string' },
		{ re: '\\$\\{?[A-Za-z_][\\w]*\\}?', cls: 'type' },
		{ re: '[A-Za-z_][\\w-]*', cls: 'ident-sh' }
	],
	markup: [
		{ re: '<!--[\\s\\S]*?-->', cls: 'comment' },
		{ re: '"(?:[^"]*)"', cls: 'string' },
		{ re: "'(?:[^']*)'", cls: 'string' },
		{ re: '</?[A-Za-z][\\w:-]*', cls: 'tag' },
		{ re: '/?>', cls: 'tag' }
	]
};

function classify(token: string, cls: string): string {
	if (cls === 'ident-js') {
		if (JS_KW.has(token)) return wrap('keyword', token);
		if (JS_LIT.has(token)) return wrap('number', token);
		if (JS_TYPE.has(token) || /^[A-Z]/.test(token)) return wrap('type', token);
		return esc(token);
	}
	if (cls === 'ident-py') {
		if (PY_KW.has(token)) return wrap('keyword', token);
		if (/^[A-Z]/.test(token)) return wrap('type', token);
		return esc(token);
	}
	if (cls === 'ident-sh') {
		if (SH_KW.has(token)) return wrap('keyword', token);
		return esc(token);
	}
	return wrap(cls, token);
}

function wrap(cls: string, token: string): string {
	return `<span class="tok-${cls}">${esc(token)}</span>`;
}

function modeFor(filename: string): Mode {
	const ext = filename.split('.').pop()?.toLowerCase() ?? '';
	return EXT_MODE[ext] ?? 'plain';
}

// Renvoie l'HTML coloré (déjà échappé) du code. Pour les modes 'plain' (md, txt,
// yaml…) : simple échappement, pas de tokenizer.
export function highlightCode(code: string, filename: string): string {
	const mode = modeFor(filename);
	if (mode === 'plain') return esc(code);
	const rules = RULES[mode];
	const re = new RegExp(rules.map((r) => `(${r.re})`).join('|'), 'g');
	let out = '';
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(code)) !== null) {
		if (m.index > last) out += esc(code.slice(last, m.index));
		// Quelle règle a matché ? Premier groupe capturant non-undefined.
		let gi = 1;
		while (gi < m.length && m[gi] === undefined) gi++;
		out += classify(m[0], rules[gi - 1].cls);
		last = re.lastIndex;
		if (m[0] === '') re.lastIndex++; // garde-fou anti-boucle infinie
	}
	out += esc(code.slice(last));
	return out;
}

// True si on sait colorer ce fichier (sert à choisir entre rendu coloré et brut).
export function isHighlightable(filename: string): boolean {
	return modeFor(filename) !== 'plain';
}
