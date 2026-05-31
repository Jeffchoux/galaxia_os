# agents/veille — module de veille IA quotidien

Scaffold du job de veille quotidien de la galaxie mère (cf. `BRIEFING.md` §
"Veille et auto-amélioration"). Il scrute des sources publiques, filtre par
mots-clés Galaxia et synthétise via Ollama local en un rapport markdown.

## Prérequis

- Node.js ≥ 22 (utilise `fetch` natif, `node:test`, ESM)
- Ollama local sur `http://127.0.0.1:11434` avec `qwen3:8b` (pull sur OpenJeff
  le 2026-05-31 ; bascule depuis `llama3.1:8b` — voir `docs/STATUS.md`)
- Accès sortant HTTPS vers `hn.algolia.com`, `github.com`, `export.arxiv.org`

Aucune dépendance npm tierce. Le `package.json` est volontairement vide côté
`dependencies`.

## Usage

```bash
cd agents/veille
node index.js
# → écrit docs/veille/YYYY-MM-DD.md
```

Variables d'environnement :

| Variable        | Défaut                                  | Rôle                          |
|-----------------|-----------------------------------------|-------------------------------|
| `OLLAMA_URL`    | `http://127.0.0.1:11434/api/generate`   | Endpoint Ollama               |
| `OLLAMA_MODEL`  | `qwen3:8b`                              | Modèle utilisé pour les TLDR  |

Le script est **idempotent** sur la journée : relancer le même jour écrase le
rapport du jour. Si une source est down, l'erreur est loggée dans le rapport au
lieu de tuer le job.

## Sources

| Source           | Mode               | Fichier                          |
|------------------|--------------------|----------------------------------|
| HackerNews       | API publique Algolia | `sources/hackernews.js`        |
| GitHub Trending  | HTML scrape (défensif, anon) | `sources/github-trending.js` |
| arXiv cs.AI/LG   | RSS                | `sources/arxiv.js`               |

### Ajouter une source

1. Créer `sources/ma-source.js` exportant `async function fetchMaSource()` qui
   retourne un tableau d'items au format :
   ```js
   { source: 'ma-source', title, url, summary, /* champs optionnels */ }
   ```
2. L'enregistrer dans `index.js` à l'intérieur du `Promise.all` (helper `safe`).
3. Optionnel : l'ajouter à l'ordre d'affichage dans `synthesize.js` (`order` et
   `humanSource`).

## Filtrage

Les mots-clés sont dans `filter.js` (`DEFAULT_KEYWORDS`). Tout item dont le
titre ou la description contient ≥1 mot-clé est conservé. Ajouter / retirer
des mots-clés directement dans cette constante.

## Tests

```bash
cd agents/veille
node --test test/
```

- `test/filter.test.js` — tests unitaires offline (filtrage, parsers HTML/RSS)
- `test/ollama.integration.test.js` — test d'intégration qui appelle Ollama si
  joignable, **skippé sinon** (probe `/api/tags` avec timeout 2 s)

## Activer le cron

Pas activé par défaut. Une fois validé, ajouter dans le crontab de l'utilisateur
`galaxia` :

```cron
# tous les jours à 06:30 heure du serveur
30 6 * * * cd /home/galaxia/galaxia-project/agents/veille && /usr/bin/node index.js >> /var/log/galaxia-veille.log 2>&1
```

À terme : remplacer par une unit systemd (`galaxia-veille.service` +
`galaxia-veille.timer`) pour bénéficier des logs `journalctl` et du `Restart=`.

## Format du rapport

Voir `docs/veille/EXAMPLE.md` pour un exemple de sortie attendue.
