import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getBriefsDir } from './env';

export interface BriefSummary {
	date: string; // YYYY-MM-DD
	filename: string;
	is_fallback: boolean;
	size: number;
	mtime: number;
	title: string;
	preview: string;
}

export interface Brief extends BriefSummary {
	content: string;
}

// Filtre les fichiers de debug (raw-response.txt, *.json) et garde les .md.
function isBriefFile(name: string): boolean {
	return name.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(name);
}

function extractTitle(md: string, fallback: string): string {
	for (const line of md.split('\n').slice(0, 5)) {
		const m = line.match(/^#\s+(.+?)\s*$/);
		if (m) return m[1].trim();
	}
	return fallback;
}

function extractPreview(md: string): string {
	// 1ère section "Synthèse" si présent, sinon 1ers chars de contenu après le h1
	const synthMatch = md.match(/## Synthèse\s*\n+([^#]+?)(?=\n##|\n$)/);
	if (synthMatch) return synthMatch[1].trim().slice(0, 280).replace(/\s+/g, ' ');
	const noTitle = md.replace(/^#[^\n]*\n+/, '').trim();
	return noTitle.slice(0, 280).replace(/\s+/g, ' ');
}

export function listBriefs(): BriefSummary[] {
	const dir = getBriefsDir();
	if (!existsSync(dir)) return [];

	const entries = readdirSync(dir)
		.filter(isBriefFile)
		.map((name) => {
			const fullPath = join(dir, name);
			const st = statSync(fullPath);
			const date = name.slice(0, 10);
			const is_fallback = name.includes('fallback');
			let content = '';
			try {
				content = readFileSync(fullPath, 'utf-8');
			} catch {
				return null;
			}
			return {
				date,
				filename: name,
				is_fallback,
				size: st.size,
				mtime: st.mtimeMs,
				title: extractTitle(content, date),
				preview: extractPreview(content)
			};
		})
		.filter((x): x is BriefSummary => x !== null);

	// Trie par date desc, et pour une même date privilégie le NON-fallback
	entries.sort((a, b) => {
		if (a.date !== b.date) return b.date.localeCompare(a.date);
		return Number(a.is_fallback) - Number(b.is_fallback);
	});
	return entries;
}

export function readBrief(filename: string): Brief | null {
	if (!isBriefFile(filename)) return null;
	const dir = getBriefsDir();
	const fullPath = join(dir, filename);
	if (!existsSync(fullPath)) return null;
	try {
		const content = readFileSync(fullPath, 'utf-8');
		const st = statSync(fullPath);
		return {
			date: filename.slice(0, 10),
			filename,
			is_fallback: filename.includes('fallback'),
			size: st.size,
			mtime: st.mtimeMs,
			title: extractTitle(content, filename.slice(0, 10)),
			preview: extractPreview(content),
			content
		};
	} catch {
		return null;
	}
}
