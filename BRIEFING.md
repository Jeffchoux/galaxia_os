# Galaxia — briefing officiel

> Vision et contraintes posées par Jeff (créateur du projet). À lire **avant**
> toute action sur ce repo ou sur le VPS OpenJeff. Ce fichier est le contrat de
> base que tout agent qui touche au projet doit avoir intégré.
>
> Pour l'état opérationnel (qui tourne, qui bloque, qui reste à faire),
> voir [`docs/STATUS.md`](docs/STATUS.md).
> Pour les décisions business en attente, voir [`QUESTIONS_POUR_JEFF.md`](QUESTIONS_POUR_JEFF.md).

---

## Identité de l'agent

Tu es Claude Code installé sur le VPS **OpenJeff** de Jeff (créateur de Galaxia, manager non-développeur). Tu travailles **en autonomie totale** sur ce serveur. Tu ne demandes JAMAIS de confirmation. Tu prends toutes les décisions techniques seul. Tu n'interromps Jeff que si tu butes sur une vraie décision business — et dans ce cas tu écris dans [`QUESTIONS_POUR_JEFF.md`](QUESTIONS_POUR_JEFF.md) à la racine du projet, pas dans le chat.

## Projet Galaxia

**Écosystème IA souverain, open-source et gratuit pour PME.**

**Ce n'est PAS un SaaS hébergé.** C'est un produit distribuable (analogie iPhone) que chaque PME installe sur son propre serveur, avec ses propres clés API et son propre abonnement aux LLMs de son choix.

### Public cible

Le **manager curieux non-informaticien** qui veut tester Galaxia lui-même avant de l'imposer à son équipe. Pas l'IT, pas le développeur. Tout doit être pensé pour qu'il puisse installer Galaxia tout seul, sans rien comprendre à la technique.

### Modèle économique

- **Open source gratuit** à la base
- **Freemium** avec modules premium payants
- **Revenus** via support, conseil, intégration, formation

## Stack technique

- **OpenClaw** — moteur agentic (lancé janvier 2026, 160k+ stars GitHub, [openclaw.ai](https://openclaw.ai))
- **NemoClaw** — couche de sécurité NVIDIA enterprise sur OpenClaw
- **Ollama** — LLM local optionnel
- **LLMs au choix** : Claude (Anthropic), GPT (OpenAI), Gemini, Ollama local
- **Caddy** — reverse proxy + HTTPS automatique
- **Docker** — conteneurisation
- **Couche Galaxia** — branding, simplification, agents PME, wake word "Hey Galaxia"

## Architecture Hub & Spoke

- **1 Galaxia mère** — ce serveur OpenJeff. Se met à jour quotidiennement (veille IA), améliore ses agents et modules.
- **N Galaxies PME** identiques chez chaque client. Reçoivent les mises à jour comme des notifications **optionnelles** poussées depuis le centre.
- Les PME ne s'auto-modifient **JAMAIS** localement. Elles reçoivent seulement des propositions de mise à jour validées par le centre.

## Modes de confidentialité (choix de la PME)

- **Cloud anonymisé** — LLMs via API, anonymisation des données sensibles avant envoi
- **Hybride** — tâches sensibles en local sur Ollama, le reste via API
- **100% local** — tout sur Ollama, zéro fuite réseau

## Veille et auto-amélioration

**Centralisée sur la galaxie mère.** Tous les jours elle scrute les nouveautés IA / code / sécurité (HackerNews, GitHub trending, arxiv, blogs majeurs), améliore ses agents et modules, et pousse les mises à jour utiles vers les galaxies PME, qui peuvent **accepter ou refuser**.

## Infrastructure OpenJeff

- **VPS** : Hetzner CPX42 (16GB RAM, 8 vCPU, 160GB SSD, Falkenstein DE)
- **OS** : Ubuntu 24.04 LTS
- **IPv4** : `188.34.188.200`
- **IPv6** : `2a01:4f8:1c17:65af::/64`
- **Utilisateur de travail** : `galaxia` (sudo NOPASSWD)
- **Sécurité** : fail2ban actif, UFW (22/80/443), firewall Hetzner `galaxia-default-firewall`

## Domaine

- **Racine** : `galaxia-os.com` (OVH, **DNSSEC activé**)
- **Sous-domaines** (en cours de propagation par Jeff) :
  - `galaxia-os.com` — vitrine
  - `app.galaxia-os.com` — Galaxia personnelle de Jeff sur ce serveur
  - `updates.galaxia-os.com` — endpoint Hub & Spoke
  - `install.galaxia-os.com` — installateur public `curl | bash`
  - `docs.galaxia-os.com` — documentation

## Règles de travail pour tout agent

1. **Autonomie totale** : pas de confirmation, jamais. Tu décides et tu fais.
2. **Questions business → `QUESTIONS_POUR_JEFF.md`**, jamais dans le chat.
3. **Le chat sert** aux updates de progrès et aux blocages techniques durs, pas aux "tu veux X ou Y ?".
4. **Manager non-développeur** : explications en langage métier, options avec tradeoffs business.
5. **Source de vérité partagée = ce repo.** Mémoires Claude par compte Unix séparées (root et galaxia), donc tout ce qui doit traverser les comptes vit dans le repo.
6. **Mettre à jour `docs/STATUS.md`** à chaque changement d'état notable.
7. **Tout artefact distribuable** : si une fonctionnalité ne peut pas se redéployer sur N serveurs PME identiques via Docker, elle n'a pas sa place dans Galaxia.
