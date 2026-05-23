import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getDbPath } from './env';

export interface Conversation {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
	summary: string | null;
	summary_until_idx: number;
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

let _db: Database.Database | null = null;
let _stmts: ReturnType<typeof prepare> | null = null;

function prepare(db: Database.Database) {
	return {
		listConversations: db.prepare<[], Conversation>(
			'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50'
		),
		getConversation: db.prepare<[string], Conversation>(
			'SELECT * FROM conversations WHERE id = ?'
		),
		createConversation: db.prepare(
			'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
		),
		updateConversation: db.prepare(
			'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?'
		),
		touchConversation: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
		updateSummary: db.prepare(
			'UPDATE conversations SET summary = ?, summary_until_idx = ?, updated_at = ? WHERE id = ?'
		),
		listMessages: db.prepare<[string], Message>(
			'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
		),
		insertMessage: db.prepare(
			'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
		),
		listDocsMeta: db.prepare<[string], DocumentMeta>(
			'SELECT id, conversation_id, filename, mime_type, size, uploaded_at FROM documents WHERE conversation_id = ? ORDER BY uploaded_at ASC'
		),
		listDocsFull: db.prepare<[string], Document>(
			'SELECT * FROM documents WHERE conversation_id = ? ORDER BY uploaded_at ASC'
		),
		getDoc: db.prepare<[string], Document>('SELECT * FROM documents WHERE id = ?'),
		insertDoc: db.prepare(
			'INSERT INTO documents (id, conversation_id, filename, mime_type, content_text, content_b64, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		),
		deleteDoc: db.prepare('DELETE FROM documents WHERE id = ? AND conversation_id = ?')
	};
}

function migrate(db: Database.Database) {
	const cols = new Set<string>(
		(db.pragma('table_info(conversations)') as Array<{ name: string }>).map((c) => c.name)
	);
	if (!cols.has('summary')) {
		db.exec('ALTER TABLE conversations ADD COLUMN summary TEXT');
	}
	if (!cols.has('summary_until_idx')) {
		db.exec('ALTER TABLE conversations ADD COLUMN summary_until_idx INTEGER NOT NULL DEFAULT 0');
	}
}

function stmts() {
	if (_stmts) return _stmts;
	const path = getDbPath();
	mkdirSync(dirname(path), { recursive: true });
	_db = new Database(path);
	_db.pragma('journal_mode = WAL');
	_db.pragma('foreign_keys = ON');
	_db.exec(`
		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL DEFAULT 'Nouvelle conversation',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			summary TEXT,
			summary_until_idx INTEGER NOT NULL DEFAULT 0
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
	`);
	migrate(_db);
	_stmts = prepare(_db);
	return _stmts;
}

export function listConversations(): Conversation[] {
	return stmts().listConversations.all();
}

export function getConversation(id: string): Conversation | undefined {
	return stmts().getConversation.get(id);
}

export function createConversation(title?: string): Conversation {
	const now = Date.now();
	const id = randomUUID();
	const t = title ?? 'Nouvelle conversation';
	stmts().createConversation.run(id, t, now, now);
	return {
		id,
		title: t,
		created_at: now,
		updated_at: now,
		summary: null,
		summary_until_idx: 0
	};
}

export function renameConversation(id: string, title: string): void {
	stmts().updateConversation.run(title, Date.now(), id);
}

export function touchConversation(id: string): void {
	stmts().touchConversation.run(Date.now(), id);
}

export function updateSummary(id: string, summary: string, summary_until_idx: number): void {
	stmts().updateSummary.run(summary, summary_until_idx, Date.now(), id);
}

export function listMessages(conversationId: string): Message[] {
	return stmts().listMessages.all(conversationId);
}

export function appendMessage(
	conversationId: string,
	role: 'user' | 'assistant',
	content: string
): Message {
	const id = randomUUID();
	const now = Date.now();
	stmts().insertMessage.run(id, conversationId, role, content, now);
	touchConversation(conversationId);
	return { id, conversation_id: conversationId, role, content, created_at: now };
}

export function listConversationDocuments(conversationId: string): DocumentMeta[] {
	return stmts().listDocsMeta.all(conversationId);
}

export function loadConversationDocuments(conversationId: string): Document[] {
	return stmts().listDocsFull.all(conversationId);
}

export function getDocument(id: string): Document | undefined {
	return stmts().getDoc.get(id);
}

export function createDocument(doc: {
	conversation_id: string;
	filename: string;
	mime_type: string;
	content_text: string | null;
	content_b64: string | null;
	size: number;
}): DocumentMeta {
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
	touchConversation(doc.conversation_id);
	return {
		id,
		conversation_id: doc.conversation_id,
		filename: doc.filename,
		mime_type: doc.mime_type,
		size: doc.size,
		uploaded_at: now
	};
}

export function deleteDocument(id: string, conversation_id: string): boolean {
	const res = stmts().deleteDoc.run(id, conversation_id);
	return res.changes > 0;
}
