#!/usr/bin/env node
/**
 * MCP server Galaxia — expose les données du cockpit (conversations,
 * briefs, mémoire) à n'importe quel client MCP : Claude Desktop, Claude
 * Code, ou autre.
 *
 * Lecture-seule sur la SQLite du cockpit (mode WAL, safe en concurrent
 * avec le cockpit Node qui écrit). Transport stdio.
 *
 * Utilisation depuis Claude Desktop (claude_desktop_config.json) :
 *   { "mcpServers": { "galaxia": {
 *       "command": "node",
 *       "args": ["/path/to/apps/mcp-galaxia/index.mjs"],
 *       "env": { "GALAXIA_DB_PATH": "/path/to/cockpit.db",
 *                "GALAXIA_BRIEFS_DIR": "/path/to/briefs",
 *                "GALAXIA_MEMORY_PATH": "/path/to/memory.md" } } } }
 *
 * Si le cockpit n'est pas sur la même machine, utiliser SSH comme
 * transport : "command": "ssh", "args": ["user@host", "node", "..."]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const DB_PATH =
	process.env.GALAXIA_DB_PATH ||
	'/home/galaxia/galaxia-project/apps/cockpit/data/cockpit.db';
const BRIEFS_DIR =
	process.env.GALAXIA_BRIEFS_DIR || '/home/galaxia/.claude/galaxia/briefs';
const MEMORY_PATH =
	process.env.GALAXIA_MEMORY_PATH || join(dirname(DB_PATH), 'memory.md');

if (!existsSync(DB_PATH)) {
	console.error(`[mcp-galaxia] DB introuvable : ${DB_PATH}`);
	process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL');

const stmts = {
	listConversations: db.prepare(
		'SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?'
	),
	getConversation: db.prepare(
		'SELECT id, title, created_at, updated_at, summary FROM conversations WHERE id = ?'
	),
	listMessages: db.prepare(
		'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
	),
	searchConversations: db.prepare(
		`SELECT DISTINCT c.id, c.title, c.updated_at
		 FROM conversations c
		 JOIN messages m ON m.conversation_id = c.id
		 WHERE m.content LIKE ?
		 ORDER BY c.updated_at DESC
		 LIMIT ?`
	)
};

const TOOLS = [
	{
		name: 'galaxia_list_conversations',
		description:
			'Liste les conversations Galaxia les plus récentes (titre + dates). Utile pour voir ce sur quoi Jeff a échangé avec Galaxia récemment.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Nombre max (défaut 20, max 100)' }
			}
		}
	},
	{
		name: 'galaxia_read_conversation',
		description:
			"Lit le contenu complet d'une conversation Galaxia (tous les messages user/assistant + summary auto-résumé éventuel).",
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: "id UUID de la conversation" }
			},
			required: ['id']
		}
	},
	{
		name: 'galaxia_search_conversations',
		description:
			'Recherche full-text dans les messages de toutes les conversations Galaxia. Retourne titre + id des convs matchantes.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Texte à chercher (case-insensitive)' },
				limit: { type: 'number', description: 'Nombre max (défaut 20)' }
			},
			required: ['query']
		}
	},
	{
		name: 'galaxia_read_memory',
		description:
			'Lit le contenu de la mémoire persistante Galaxia (memory.md, injectée dans le system prompt de toutes les conversations).',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'galaxia_list_briefs',
		description:
			'Liste les briefs quotidiens produits par le pipeline digest Galaxia (analyse Whisper+Claude des TikToks/X reçus par bot Telegram).',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Nombre max (défaut 20)' }
			}
		}
	},
	{
		name: 'galaxia_read_brief',
		description: 'Lit le contenu complet d\'un brief Galaxia par date ou filename.',
		inputSchema: {
			type: 'object',
			properties: {
				date_or_filename: {
					type: 'string',
					description: 'YYYY-MM-DD ou nom de fichier (ex: "2026-05-23")'
				}
			},
			required: ['date_or_filename']
		}
	}
];

function fmtTimestamp(ts) {
	return new Date(ts).toISOString();
}

function asText(text) {
	return { content: [{ type: 'text', text }] };
}

function asError(msg) {
	return { isError: true, content: [{ type: 'text', text: msg }] };
}

function listBriefsOnDisk() {
	if (!existsSync(BRIEFS_DIR)) return [];
	return readdirSync(BRIEFS_DIR)
		.filter((n) => n.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(n))
		.map((n) => {
			const p = join(BRIEFS_DIR, n);
			const st = statSync(p);
			return {
				filename: n,
				date: n.slice(0, 10),
				is_fallback: n.includes('fallback'),
				size: st.size,
				mtime: st.mtimeMs
			};
		})
		.sort((a, b) => {
			if (a.date !== b.date) return b.date.localeCompare(a.date);
			return Number(a.is_fallback) - Number(b.is_fallback);
		});
}

async function handleCall(name, args = {}) {
	if (name === 'galaxia_list_conversations') {
		const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
		const rows = stmts.listConversations.all(limit);
		const lines = rows.map(
			(r) =>
				`- [${r.id.slice(0, 8)}] ${r.title} (updated ${fmtTimestamp(r.updated_at)})`
		);
		return asText(lines.join('\n') || '(aucune conversation)');
	}

	if (name === 'galaxia_read_conversation') {
		const id = String(args.id || '');
		if (!id) return asError('id manquant');
		const conv = stmts.getConversation.get(id);
		if (!conv) return asError(`Conversation ${id} introuvable`);
		const msgs = stmts.listMessages.all(id);
		const parts = [`# ${conv.title}`, `id: ${conv.id}`, `created: ${fmtTimestamp(conv.created_at)}`];
		if (conv.summary) parts.push(`\n## Résumé auto\n\n${conv.summary}`);
		parts.push('\n## Messages\n');
		for (const m of msgs) {
			parts.push(`### ${m.role === 'user' ? 'Jeff' : 'Galaxia'} (${fmtTimestamp(m.created_at)})\n\n${m.content}`);
		}
		return asText(parts.join('\n'));
	}

	if (name === 'galaxia_search_conversations') {
		const q = String(args.query || '').trim();
		if (!q) return asError('query manquante');
		const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
		const rows = stmts.searchConversations.all(`%${q}%`, limit);
		const lines = rows.map(
			(r) => `- [${r.id.slice(0, 8)}] ${r.title} (updated ${fmtTimestamp(r.updated_at)})`
		);
		return asText(lines.join('\n') || `(aucune conversation ne contient « ${q} »)`);
	}

	if (name === 'galaxia_read_memory') {
		if (!existsSync(MEMORY_PATH)) return asText('(memory.md vide)');
		const content = readFileSync(MEMORY_PATH, 'utf-8');
		return asText(content);
	}

	if (name === 'galaxia_list_briefs') {
		const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
		const briefs = listBriefsOnDisk().slice(0, limit);
		const lines = briefs.map(
			(b) =>
				`- ${b.date}${b.is_fallback ? ' [fallback]' : ''} — ${b.filename} (${b.size} octets)`
		);
		return asText(lines.join('\n') || '(aucun brief)');
	}

	if (name === 'galaxia_read_brief') {
		const key = String(args.date_or_filename || '').trim();
		if (!key) return asError('date_or_filename manquant');
		const all = listBriefsOnDisk();
		const found = all.find((b) => b.date === key || b.filename === key) || all[0];
		if (!found) return asError(`Brief ${key} introuvable`);
		const p = join(BRIEFS_DIR, found.filename);
		const content = readFileSync(p, 'utf-8');
		return asText(content);
	}

	return asError(`Tool inconnu : ${name}`);
}

const server = new Server(
	{ name: 'galaxia', version: '0.1.0' },
	{ capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
	try {
		return await handleCall(req.params.name, req.params.arguments || {});
	} catch (e) {
		return asError(e instanceof Error ? e.message : String(e));
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mcp-galaxia] connected via stdio');
