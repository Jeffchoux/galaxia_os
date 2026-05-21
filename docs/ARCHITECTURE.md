# Architecture Galaxia

## Vue d'ensemble

Galaxia est un **produit fini distribuable**, pas un SaaS. Cette contrainte
guide toutes les décisions techniques :

- Toute fonctionnalité doit pouvoir être packagée et redéployée sur N serveurs PME identiques
- Pas de dépendance à des services externes propriétaires
- Chaque PME garde ses clés API et ses données chez elle

## Hub & Spoke

```
                ┌──────────────────────┐
                │   Galaxia mère       │
                │   (OpenJeff VPS)     │
                │   updates.galaxia-os │
                └──────────┬───────────┘
                           │ daily pull
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
  ┌─────────┐         ┌─────────┐         ┌─────────┐
  │ PME #1  │         │ PME #2  │   ...   │ PME #N  │
  │ Galaxia │         │ Galaxia │         │ Galaxia │
  └─────────┘         └─────────┘         └─────────┘
```

- **Galaxia mère** : ce serveur. Reçoit les mises à jour des composants
  (OpenClaw, NemoClaw, modules) et les publie sur `updates.galaxia-os.com`.
- **Galaxies filles** : installations identiques chez les PME. Elles
  vérifient quotidiennement la disponibilité d'une mise à jour et la
  récupèrent automatiquement.

## Sous-domaines (galaxia-os.com)

| Sous-domaine                | Rôle                                              |
|-----------------------------|---------------------------------------------------|
| `app.galaxia-os.com`        | Interface utilisateur de la galaxie mère          |
| `updates.galaxia-os.com`    | Endpoint des mises à jour pour les galaxies filles|
| `install.galaxia-os.com`    | Script d'installation public                      |
| `docs.galaxia-os.com`       | Documentation                                     |

## Stack runtime

- **Docker + docker-compose** : orchestration des services Galaxia
- **Caddy** : reverse proxy + HTTPS automatique (Let's Encrypt)
- **Ollama** : LLM local — tourne en service système sur la mère,
  containerisé sur les filles pour la reproductibilité
- **OpenClaw** : moteur agentic (sortie janvier 2026)
- **NemoClaw** : couche sécurité NVIDIA enterprise au-dessus d'OpenClaw

## Sécurité de base de la galaxie mère

- UFW : 22, 80, 443 ouverts (5678 à fermer une fois n8n derrière Caddy)
- fail2ban actif
- Firewall Hetzner côté infra
- Utilisateur `galaxia` pour les opérations, root réservé aux installations système
