import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { getAdminEmail, getDbPath } from './env';

export interface User {
	id: string;
	email: string;
	role: 'admin' | 'member';
	created_at: number;
}

export interface Conversation {
	id: string;
	user_id: string;
	title: string;
	created_at: number;
	updated_at: number;
	summary: string | null;
	summary_until_idx: number;
	project_id: string | null;
}

export interface Project {
	id: string;
	user_id: string;
	name: string;
	created_at: number;
	updated_at: number;
}

export interface Message {
	id: string;
	conversation_id: string;
	role: 'user' | 'assistant';
	content: string;
	created_at: number;
}

export interface Document {
	id: string;
	conversation_id: string;
	filename: string;
	mime_type: string;
	content_text: string | null;
	content_b64: string | null;
	size: number;
	uploaded_at: number;
}

export type DocumentMeta = Omit<Document, 'content_text' | 'content_b64'>;

export interface MagicLink {
	token: string;
	email: string;
	created_at: number;
	expires_at: number;
	used_at: number | null;
}

export interface UsageRecord {
	id: string;
	user_id: string | null;
	conversation_id: string | null;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cost_micros: number; // micro-USD (1 USD = 1_000_000) — entier pour éviter le float
	created_at: number;
}

let _db: Database.Database | null = null;
let _stmts: ReturnType<typeof prepare> | null = null;

// Force l'exécution de la migration sans avoir à attendre une requête HTTP
// authentifiée qui hit la DB. Appelé une fois depuis hooks.server.ts au boot.
export function ensureMigrated(): void {
	stmts();
}

function prepare(db: Database.Database) {
	return {
		// ─── users ────────────────────────────────────────────────────────────
		getUserById: db.prepare<[string], User>('SELECT * FROM users WHERE id = ?'),
		getUserByEmail: db.prepare<[string], User>('SELECT * FROM users WHERE email = ?'),
		insertUser: db.prepare(
			'INSERT INTO users (id, email, role, created_at) VALUES (?, ?, ?, ?)'
		),
		// ─── conversations (toujours scoped par user_id) ─────────────────────
		listConversations: db.prepare<[string], Conversation>(
			'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50'
		),
		getConversation: db.prepare<[string, string], Conversation>(
			'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
		),
		createConversation: db.prepare(
			'INSERT INTO conversations (id, user_id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
		),
		updateConversation: db.prepare(
			'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?'
		),
		setConversationProject: db.prepare(
			'UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
		),
		touchConversation: db.prepare(
			'UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?'
		),
		updateSummary: db.prepare(
			'UPDATE conversations SET summary = ?, summary_until_idx = ?, updated_at = ? WHERE id = ? AND user_id = ?'
		),
		// ─── projects (regroupement des conversations, style Claude Code) ────
		listProjects: db.prepare<[string], Project>(
			'SELECT * FROM projects WHERE user_id = ? ORDER BY created_at ASC'
		),
		getProject: db.prepare<[string, string], Project>(
			'SELECT * FROM projects WHERE id = ? AND user_id = ?'
		),
		createProject: db.prepare(
			'INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
		),
		renameProject: db.prepare(
			'UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?'
		),
		deleteProject: db.prepare(
			'DELETE FROM projects WHERE id = ? AND user_id = ?'
		),
		// ─── messages (héritent du user_id via la conversation) ──────────────
		listMessages: db.prepare<[string, string], Message>(
			`SELECT m.* FROM messages m
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE m.conversation_id = ? AND c.user_id = ?
			 ORDER BY m.created_at ASC`
		),
		insertMessage: db.prepare(
			'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
		),
		// ─── documents (héritent du user_id via la conversation) ─────────────
		listAllDocs: db.prepare<
			[string, number],
			DocumentMeta & { conversation_title: string }
		>(
			`SELECT d.id, d.conversation_id, d.filename, d.mime_type, d.size,
			        d.uploaded_at, c.title AS conversation_title
			 FROM documents d
			 JOIN conversations c ON c.id = d.conversation_id
			 WHERE c.user_id = ?
			 ORDER BY d.uploaded_at DESC
			 LIMIT ?`
		),
		listDocsMeta: db.prepare<[string, string], DocumentMeta>(
			`SELECT d.id, d.conversation_id, d.filename, d.mime_type, d.size, d.uploaded_at
			 FROM documents d
			 JOIN conversations c ON c.id = d.conversation_id
			 WHERE d.conversation_id = ? AND c.user_id = ?
			 ORDER BY d.uploaded_at ASC`
		),
		listDocsFull: db.prepare<[string, string], Document>(
			`SELECT d.* FROM documents d
			 JOIN conversations c ON c.id = d.conversation_id
			 WHERE d.conversation_id = ? AND c.user_id = ?
			 ORDER BY d.uploaded_at ASC`
		),
		getDoc: db.prepare<[string, string], Document>(
			`SELECT d.* FROM documents d
			 JOIN conversations c ON c.id = d.conversation_id
			 WHERE d.id = ? AND c.user_id = ?`
		),
		insertDoc: db.prepare(
			'INSERT INTO documents (id, conversation_id, filename, mime_type, content_text, content_b64, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		),
		deleteDoc: db.prepare(
			`DELETE FROM documents WHERE id = ? AND conversation_id = ? AND conversation_id IN
			 (SELECT id FROM conversations WHERE user_id = ?)`
		),
		// ─── magic links (Sprint 2 PR-C, schéma posé ici) ────────────────────
		insertMagicLink: db.prepare(
			'INSERT INTO magic_links (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)'
		),
		getMagicLink: db.prepare<[string], MagicLink>(
			'SELECT * FROM magic_links WHERE token = ?'
		),
		markMagicLinkUsed: db.prepare(
			'UPDATE magic_links SET used_at = ? WHERE token = ? AND used_at IS NULL'
		),
		purgeExpiredMagicLinks: db.prepare(
			'DELETE FROM magic_links WHERE expires_at < ?'
		),
		// ─── usage (Sprint 2 PR-D, schéma posé ici) ──────────────────────────
		insertUsage: db.prepare(
			'INSERT INTO usage (id, user_id, conversation_id, model, input_tokens, output_tokens, cost_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		)
	};
}

function migrate(db: Database.Database) {
	// 1. Colonnes ajoutées sur la table conversations au fil du temps
	const convCols = new Set<string>(
		(db.pragma('table_info(conversations)') as Array<{ name: string }>).map((c) => c.name)
	);
	if (!convCols.has('summary')) {
		db.exec('ALTER TABLE conversations ADD COLUMN summary TEXT');
	}
	if (!convCols.has('summary_until_idx')) {
		db.exec('ALTER TABLE conversations ADD COLUMN summary_until_idx INTEGER NOT NULL DEFAULT 0');
	}
	// Multi-user (Sprint 2 PR-A) : on ajoute user_id sans contrainte NOT NULL
	// au niveau SQL — SQLite ne sait pas ajouter une colonne NOT NULL sur une
	// table existante sans default. L'app garantit le NOT NULL en pratique
	// (toutes les écritures passent par createConversation qui exige user_id).
	if (!convCols.has('user_id')) {
		db.exec('ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL');
	}
	// L'index sur user_id ne peut être créé qu'une fois la colonne en place
	// (l'ALTER ci-dessus passe juste avant si la table existait d'une version
	// pré-multi-user). Sur une fresh install, la colonne est déjà créée par le
	// CREATE TABLE de stmts() et l'index est posé ici sans rejouer l'ALTER.
	db.exec('CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC)');

	// Regroupement par projet (Galaxia 2.0 WS3). project_id ajouté sans NOT NULL
	// (une conversation peut ne pas appartenir à un projet — section « hors projet »).
	if (!convCols.has('project_id')) {
		db.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL');
	}
	db.exec('CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id, updated_at DESC)');

	// 2. Provision de l'admin (Jeff) + backfill des conversations historiques
	const adminEmail = getAdminEmail();
	const existing = db
		.prepare<[string], { id: string }>('SELECT id FROM users WHERE email = ?')
		.get(adminEmail);
	let adminId: string;
	if (existing) {
		adminId = existing.id;
	} else {
		adminId = randomUUID();
		db.prepare(
			'INSERT INTO users (id, email, role, created_at) VALUES (?, ?, ?, ?)'
		).run(adminId, adminEmail, 'admin', Date.now());
	}
	// Rattache toute conversation orpheline (avant migration) à l'admin.
	db.prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL').run(adminId);
}

function stmts() {
	if (_stmts) return _stmts;
	const path = getDbPath();
	mkdirSync(dirname(path), { recursive: true });
	_db = new Database(path);
	_db.pragma('journal_mode = WAL');
	_db.pragma('foreign_keys = ON');
	_db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, created_at);
		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL DEFAULT 'Nouvelle conversation',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			summary TEXT,
			summary_until_idx INTEGER NOT NULL DEFAULT 0,
			user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			project_id TEXT REFERENCES projects(id) ON DELETE SET NULL
		);
		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			role TEXT NOT NULL CHECK (role IN ('user','assistant')),
			content TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
		-- idx_conv_user (user_id) créé par migrate() APRÈS l'ALTER TABLE qui ajoute la colonne.
		CREATE TABLE IF NOT EXISTS documents (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			filename TEXT NOT NULL,
			mime_type TEXT NOT NULL,
			content_text TEXT,
			content_b64 TEXT,
			size INTEGER NOT NULL,
			uploaded_at INTEGER NOT NULL,
			CHECK ((content_text IS NULL) <> (content_b64 IS NULL))
		);
		CREATE INDEX IF NOT EXISTS idx_docs_conv ON documents(conversation_id, uploaded_at);
		CREATE TABLE IF NOT EXISTS magic_links (
			token TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			used_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
		CREATE INDEX IF NOT EXISTS idx_magic_links_exp ON magic_links(expires_at);
		CREATE TABLE IF NOT EXISTS usage (
			id TEXT PRIMARY KEY,
			user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			conversation_id TEXT,
			model TEXT NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cost_micros INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at DESC);
	`);
	migrate(_db);
	_stmts = prepare(_db);
	return _stmts;
}

// ─── users ──────────────────────────────────────────────────────────────────

export function getUserById(id: string): User | undefined {
	return stmts().getUserById.get(id);
}

export function getUserByEmail(email: string): User | undefined {
	return stmts().getUserByEmail.get(email.toLowerCase());
}

export function createUser(email: string, role: 'admin' | 'member' = 'member'): User {
	const id = randomUUID();
	const now = Date.now();
	const normalized = email.toLowerCase();
	stmts().insertUser.run(id, normalized, role, now);
	return { id, email: normalized, role, created_at: now };
}

// L'admin est garanti d'exister via la migration ; ce helper sert aux flux
// (ex : login password) qui ont besoin de son id sans avoir l'email sous la main.
export function getAdminUser(): User {
	const admin = getUserByEmail(getAdminEmail());
	if (!admin) {
		// Ne devrait jamais arriver — la migration le crée. Indique une DB corrompue.
		throw new Error('admin user introuvable (migration en échec ?)');
	}
	return admin;
}

// ─── conversations ──────────────────────────────────────────────────────────

export function listConversations(userId: string): Conversation[] {
	return stmts().listConversations.all(userId);
}

export function getConversation(id: string, userId: string): Conversation | undefined {
	return stmts().getConversation.get(id, userId);
}

export function createConversation(
	userId: string,
	title?: string,
	projectId?: string | null
): Conversation {
	const now = Date.now();
	const id = randomUUID();
	const t = title ?? 'Nouvelle conversation';
	// Garde : si un projet est demandé, il doit appartenir à l'utilisateur.
	const pid = projectId && getProject(projectId, userId) ? projectId : null;
	stmts().createConversation.run(id, userId, t, pid, now, now);
	return {
		id,
		user_id: userId,
		title: t,
		created_at: now,
		updated_at: now,
		summary: null,
		summary_until_idx: 0,
		project_id: pid
	};
}

// ─── projects ───────────────────────────────────────────────────────────────

export function listProjects(userId: string): Project[] {
	return stmts().listProjects.all(userId);
}

export function getProject(id: string, userId: string): Project | undefined {
	return stmts().getProject.get(id, userId);
}

export function createProject(userId: string, name: string): Project {
	const now = Date.now();
	const id = randomUUID();
	const n = name.trim() || 'Nouveau projet';
	stmts().createProject.run(id, userId, n, now, now);
	return { id, user_id: userId, name: n, created_at: now, updated_at: now };
}

export function renameProject(id: string, userId: string, name: string): void {
	stmts().renameProject.run(name.trim() || 'Projet', Date.now(), id, userId);
}

// Supprime le projet ; les conversations rattachées repassent « hors projet »
// (project_id → NULL via la clause ON DELETE SET NULL).
export function deleteProject(id: string, userId: string): boolean {
	return stmts().deleteProject.run(id, userId).changes > 0;
}

// Range (ou sort, si projectId = null) une conversation dans un projet.
export function setConversationProject(
	id: string,
	userId: string,
	projectId: string | null
): void {
	const pid = projectId && getProject(projectId, userId) ? projectId : null;
	stmts().setConversationProject.run(pid, Date.now(), id, userId);
}

export function renameConversation(id: string, userId: string, title: string): void {
	stmts().updateConversation.run(title, Date.now(), id, userId);
}

export function touchConversation(id: string, userId: string): void {
	stmts().touchConversation.run(Date.now(), id, userId);
}

export function updateSummary(
	id: string,
	userId: string,
	summary: string,
	summary_until_idx: number
): void {
	stmts().updateSummary.run(summary, summary_until_idx, Date.now(), id, userId);
}

// ─── messages ───────────────────────────────────────────────────────────────

export function listMessages(conversationId: string, userId: string): Message[] {
	return stmts().listMessages.all(conversationId, userId);
}

export function appendMessage(
	conversationId: string,
	userId: string,
	role: 'user' | 'assistant',
	content: string
): Message {
	// Garde : la conversation doit appartenir à l'utilisateur, sinon on refuse.
	if (!getConversation(conversationId, userId)) {
		throw new Error('conversation introuvable ou non autorisée');
	}
	const id = randomUUID();
	const now = Date.now();
	stmts().insertMessage.run(id, conversationId, role, content, now);
	touchConversation(conversationId, userId);
	return { id, conversation_id: conversationId, role, content, created_at: now };
}

// ─── documents ──────────────────────────────────────────────────────────────

export function listConversationDocuments(
	conversationId: string,
	userId: string
): DocumentMeta[] {
	return stmts().listDocsMeta.all(conversationId, userId);
}

export interface DocumentWithConv extends DocumentMeta {
	conversation_title: string;
}

export function listAllDocuments(userId: string, limit = 200): DocumentWithConv[] {
	return stmts().listAllDocs.all(userId, Math.max(1, Math.min(500, limit)));
}

export function loadConversationDocuments(
	conversationId: string,
	userId: string
): Document[] {
	return stmts().listDocsFull.all(conversationId, userId);
}

export function getDocument(id: string, userId: string): Document | undefined {
	return stmts().getDoc.get(id, userId);
}

export function createDocument(doc: {
	conversation_id: string;
	user_id: string;
	filename: string;
	mime_type: string;
	content_text: string | null;
	content_b64: string | null;
	size: number;
}): DocumentMeta {
	if (!getConversation(doc.conversation_id, doc.user_id)) {
		throw new Error('conversation introuvable ou non autorisée');
	}
	const id = randomUUID();
	const now = Date.now();
	stmts().insertDoc.run(
		id,
		doc.conversation_id,
		doc.filename,
		doc.mime_type,
		doc.content_text,
		doc.content_b64,
		doc.size,
		now
	);
	touchConversation(doc.conversation_id, doc.user_id);
	return {
		id,
		conversation_id: doc.conversation_id,
		filename: doc.filename,
		mime_type: doc.mime_type,
		size: doc.size,
		uploaded_at: now
	};
}

export function deleteDocument(id: string, conversation_id: string, userId: string): boolean {
	const res = stmts().deleteDoc.run(id, conversation_id, userId);
	return res.changes > 0;
}

// ─── magic links (Sprint 2 PR-C consumera ces helpers) ─────────────────────

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 min

export function createMagicLink(email: string): MagicLink {
	const token = randomBytes(32).toString('base64url');
	const now = Date.now();
	const expires_at = now + MAGIC_LINK_TTL_MS;
	const normalized = email.toLowerCase();
	stmts().insertMagicLink.run(token, normalized, now, expires_at);
	return { token, email: normalized, created_at: now, expires_at, used_at: null };
}

// Atomique : consomme le lien si valide (non expiré, non déjà utilisé). Retourne
// l'email associé ou null. Une fois consommé, le même token ne peut plus servir.
export function consumeMagicLink(token: string): string | null {
	const link = stmts().getMagicLink.get(token);
	if (!link) return null;
	if (link.used_at !== null) return null;
	if (link.expires_at < Date.now()) return null;
	const res = stmts().markMagicLinkUsed.run(Date.now(), token);
	if (res.changes !== 1) return null;
	return link.email;
}

export function purgeExpiredMagicLinks(): number {
	const res = stmts().purgeExpiredMagicLinks.run(Date.now());
	return res.changes;
}

// ─── usage (Sprint 2 PR-D consumera ce helper) ─────────────────────────────

export function recordUsage(rec: {
	user_id: string | null;
	conversation_id: string | null;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cost_micros: number;
}): void {
	const id = randomUUID();
	stmts().insertUsage.run(
		id,
		rec.user_id,
		rec.conversation_id,
		rec.model,
		rec.input_tokens,
		rec.output_tokens,
		rec.cost_micros,
		Date.now()
	);
}
