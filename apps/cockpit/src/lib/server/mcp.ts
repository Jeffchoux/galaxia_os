/**
 * Client MCP — connecte le cockpit à des MCP servers externes via stdio.
 *
 * V1 : un seul server `filesystem` (Anthropic), scopé aux racines
 * COCKPIT_MCP_FS_ROOTS (par défaut le repo Galaxia + dossier briefs +
 * knowledge). Le server est spawné comme child process Node, communique
 * via stdio. Connection établie à la première demande, puis réutilisée.
 *
 * Pour ajouter un MCP server : étendre `MCP_SERVERS` ci-dessous (gmail,
 * slack, github, postgres, etc. — voir https://github.com/modelcontextprotocol/servers).
 */
import { env } from '$env/dynamic/private';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { GalaxiaTool } from './tools';

interface McpServerConfig {
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
}

const NODE_MODULES =
	'/home/galaxia/galaxia-project/apps/cockpit/node_modules/@modelcontextprotocol';

function buildServerConfigs(): McpServerConfig[] {
	const configs: McpServerConfig[] = [];

	// Filesystem — toujours actif, sauf si COCKPIT_MCP_FS_ROOTS=`-` pour le désactiver.
	const defaults = [
		'/home/galaxia/galaxia-project',
		'/home/galaxia/.claude/galaxia/briefs',
		'/home/galaxia/.claude/galaxia/knowledge'
	];
	const roots = (env.COCKPIT_MCP_FS_ROOTS ?? defaults.join(','))
		.split(',')
		.map((p) => p.trim())
		.filter((p) => p && p !== '-');
	if (roots.length > 0) {
		configs.push({
			name: 'filesystem',
			command: 'node',
			args: [`${NODE_MODULES}/server-filesystem/dist/index.js`, ...roots]
		});
	}

	// GitHub — actif uniquement si GITHUB_PERSONAL_ACCESS_TOKEN est posé.
	// PAT à scope minimal : `repo` (read access pour repos privés) ou `public_repo`
	// (read public). Pour Jeff sur galaxia_os (public), `public_repo` suffit.
	const ghToken = env.GITHUB_PERSONAL_ACCESS_TOKEN;
	if (ghToken) {
		configs.push({
			name: 'github',
			command: 'node',
			args: [`${NODE_MODULES}/server-github/dist/index.js`],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: ghToken }
		});
	}

	return configs;
}

interface ConnectedServer {
	name: string;
	client: Client;
	tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

let _connections: ConnectedServer[] | null = null;
let _connecting: Promise<ConnectedServer[]> | null = null;

async function connectAll(): Promise<ConnectedServer[]> {
	const list: ConnectedServer[] = [];
	for (const cfg of buildServerConfigs()) {
		try {
			const transport = new StdioClientTransport({
				command: cfg.command,
				args: cfg.args,
				// Sans `env`, le SDK ne propage QUE PATH par défaut — il faut explicitement
				// inject les credentials (GITHUB_PERSONAL_ACCESS_TOKEN, etc.).
				env: { ...process.env, ...cfg.env } as Record<string, string>
			});
			const client = new Client(
				{ name: 'galaxia-cockpit', version: '0.1.0' },
				{ capabilities: {} }
			);
			await client.connect(transport);
			const res = await client.listTools();
			list.push({
				name: cfg.name,
				client,
				tools: res.tools as ConnectedServer['tools']
			});
		} catch (e) {
			console.error(`[mcp] connexion à ${cfg.name} échouée :`, e);
		}
	}
	return list;
}

async function ensureConnections(): Promise<ConnectedServer[]> {
	if (_connections) return _connections;
	if (!_connecting) _connecting = connectAll().then((c) => (_connections = c));
	return _connecting;
}

export async function listMcpTools(): Promise<GalaxiaTool[]> {
	const conns = await ensureConnections();
	const tools: GalaxiaTool[] = [];
	for (const c of conns) {
		for (const t of c.tools) {
			tools.push({
				name: t.name,
				description: t.description ?? '',
				input_schema: (t.inputSchema as GalaxiaTool['input_schema']) ?? {
					type: 'object',
					properties: {}
				}
			});
		}
	}
	return tools;
}

export async function hasMcpTool(name: string): Promise<boolean> {
	const conns = await ensureConnections();
	return conns.some((c) => c.tools.some((t) => t.name === name));
}

export async function callMcpTool(
	name: string,
	input: Record<string, unknown>
): Promise<{ result: string; is_error?: boolean }> {
	const conns = await ensureConnections();
	const owner = conns.find((c) => c.tools.some((t) => t.name === name));
	if (!owner) return { result: `MCP tool ${name} introuvable`, is_error: true };
	try {
		const res = await owner.client.callTool({ name, arguments: input });
		const text = Array.isArray(res.content)
			? (res.content as Array<{ type: string; text?: string }>)
					.map((b) => (b.type === 'text' && b.text ? b.text : JSON.stringify(b)))
					.join('\n')
			: JSON.stringify(res.content);
		return { result: text, is_error: !!res.isError };
	} catch (e) {
		return {
			result: e instanceof Error ? e.message : String(e),
			is_error: true
		};
	}
}
