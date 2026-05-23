# MCP server Galaxia

Expose les données du cockpit Galaxia (conversations, briefs, mémoire)
à n'importe quel client MCP via le protocole standard Anthropic.

Cas d'usage typique : **utiliser Galaxia comme backend de Claude
Desktop**. Tu poses tes questions dans Claude Desktop, Claude tape
dans ta mémoire / tes conversations / tes briefs Galaxia pour te
répondre — sans avoir à ouvrir le cockpit.

## Tools exposés

| Tool                            | Effet                                                          |
|---------------------------------|----------------------------------------------------------------|
| `galaxia_list_conversations`    | Dernières conversations (titre + dates)                        |
| `galaxia_read_conversation`     | Tous les messages d'une conv + son résumé auto éventuel        |
| `galaxia_search_conversations`  | Full-text search dans toutes les conv                          |
| `galaxia_read_memory`           | Contenu de `memory.md`                                         |
| `galaxia_list_briefs`           | Briefs digest (date + filename)                                |
| `galaxia_read_brief`            | Contenu complet d'un brief                                     |

Accès **lecture seule** sur la SQLite du cockpit (mode WAL, safe en
concurrent avec le cockpit qui écrit dessus).

## Installation

### Sur la même machine que le cockpit (OpenJeff, ou fille PME hébergée)

```bash
cd apps/mcp-galaxia
npm install
node index.mjs   # transport stdio, ouvert au pipe parent
```

### Configurer Claude Desktop

Édite `claude_desktop_config.json` (path selon ton OS) :

```json
{
  "mcpServers": {
    "galaxia": {
      "command": "node",
      "args": [
        "/Users/jeffchoux/galaxia-project/apps/mcp-galaxia/index.mjs"
      ],
      "env": {
        "GALAXIA_DB_PATH": "/path/to/cockpit.db",
        "GALAXIA_BRIEFS_DIR": "/path/to/briefs",
        "GALAXIA_MEMORY_PATH": "/path/to/memory.md"
      }
    }
  }
}
```

Redémarre Claude Desktop. Tu verras un indicateur 🔧 Galaxia dans la
barre des tools.

### Si le cockpit est sur un serveur distant (cas typique : ton Mac, cockpit sur OpenJeff)

Utilise SSH comme transport :

```json
{
  "mcpServers": {
    "galaxia": {
      "command": "ssh",
      "args": [
        "-T",
        "galaxia@188.34.188.200",
        "node /home/galaxia/galaxia-project/apps/mcp-galaxia/index.mjs"
      ]
    }
  }
}
```

Ta connexion SSH doit être configurée pour ne pas demander de password
(clé publique). Le `-T` désactive l'allocation TTY (nécessaire pour
stdio).

## Variables d'environnement

| Var                    | Défaut                                                         |
|------------------------|----------------------------------------------------------------|
| `GALAXIA_DB_PATH`      | `/home/galaxia/galaxia-project/apps/cockpit/data/cockpit.db`   |
| `GALAXIA_BRIEFS_DIR`   | `/home/galaxia/.claude/galaxia/briefs`                         |
| `GALAXIA_MEMORY_PATH`  | `<dirname GALAXIA_DB_PATH>/memory.md`                          |

## Test rapide en ligne de commande

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node index.mjs
```

Doit retourner la liste des 6 tools.

## Sécurité

Le serveur ouvre la SQLite en mode `readonly`. Aucun write possible
(même via SQL injection théorique). Les paths briefs/memory sont
limités à ce qui est lisible par le user Unix qui exécute le serveur.

Pas d'auth côté MCP : c'est la responsabilité du transport (SSH +
clé publique, ou exécution locale dans un environnement de confiance).
