import { createHmac, timingSafeEqual } from 'node:crypto';
import { verify as argonVerify } from '@node-rs/argon2';
import { getJeffPassHash, getSessionSecret } from './env';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
export const SESSION_COOKIE = 'galaxia_session';

function b64url(input: Buffer | string): string {
	return Buffer.from(input).toString('base64url');
}

function fromB64url(input: string): Buffer {
	return Buffer.from(input, 'base64url');
}

function sign(payload: string): string {
	return createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
}

export interface Session {
	userId: string;
	exp: number; // ms epoch
}

export function createSession(userId: string): string {
	const session: Session = { userId, exp: Date.now() + SESSION_TTL_MS };
	const payload = b64url(JSON.stringify(session));
	return `${payload}.${sign(payload)}`;
}

export function verifySession(token: string | undefined): Session | null {
	if (!token) return null;
	const [payload, mac] = token.split('.');
	if (!payload || !mac) return null;
	const expected = sign(payload);
	const a = Buffer.from(mac);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	try {
		const session = JSON.parse(fromB64url(payload).toString()) as Session;
		if (typeof session.exp !== 'number' || session.exp < Date.now()) return null;
		return session;
	} catch {
		return null;
	}
}

export async function verifyPassword(password: string): Promise<boolean> {
	if (!password) return false;
	try {
		return await argonVerify(getJeffPassHash(), password);
	} catch {
		return false;
	}
}

export function sessionCookieOptions() {
	return {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		maxAge: Math.floor(SESSION_TTL_MS / 1000)
	};
}
