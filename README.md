# Galaxia

**Écosystème IA souverain, open-source et gratuit pour les PME.**

Galaxia n'est pas un SaaS. C'est un produit fini, distribuable (comme un iPhone) :
chaque PME l'installe sur son propre serveur avec ses propres clés API, et garde la
maîtrise complète de ses données.

## Architecture — Hub & Spoke

- **1 Galaxia mère** (ce serveur, OpenJeff) — se met à jour quotidiennement et publie les mises à jour
- **N galaxies filles** — installations identiques chez les PME, qui pullent les updates depuis la mère

## Stack

| Composant   | Rôle                                                    |
|-------------|---------------------------------------------------------|
| OpenClaw    | Moteur agentic (lancement janvier 2026, openclaw.ai)    |
| NemoClaw    | Couche de sécurité NVIDIA enterprise sur OpenClaw       |
| Ollama      | LLM local                                               |
| Caddy       | Reverse proxy + HTTPS automatique                       |
| Docker      | Packaging et déploiement reproductible                  |

Wake word par défaut : **"Hey Galaxia"**.

## Modèle

- Open source gratuit (core)
- Freemium (modules premium)
- Revenus : support, conseil, intégration

## Structure du dépôt

```
galaxia-project/
├── caddy/      # Configuration du reverse proxy
├── docs/       # Documentation produit et technique
├── ops/        # Compose files, scripts d'opération
├── scripts/    # Scripts utilitaires (bootstrap, mise à jour, etc.)
└── docker-compose.yml
```

## Licence

À définir (probablement AGPLv3 pour le core afin de préserver la souveraineté
du code redistribué).
