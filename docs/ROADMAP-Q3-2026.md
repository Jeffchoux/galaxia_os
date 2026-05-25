# Roadmap Q3 2026 — Galaxia

> **Statut :** vivant. Synthétisé le **2026-05-24** depuis un consortium de 9 sous-agents (audit cockpit, audit sécu, audit roadmap, etc.). Source unique de vérité pour la planification Q3.
>
> **Couvre :** 12 semaines (S22 → S33), ≈ 52 j-h capacité Jeff.
>
> Cette doc remplace toute mention informelle de "roadmap" dans le chat. Quand un item bouge, l'updater ici (et propager dans `docs/STATUS.md` si livré).

## Calendrier

| Sprint | Semaines  | Thème                                                              | j-h  | État    |
|--------|-----------|--------------------------------------------------------------------|------|---------|
| 1      | S22 – S23 | Hygiène & quick wins (6 items)                                     | 6.5  | ✅ livré |
| 2      | S24 – S25 | Multi-user minimum viable (table users + magic link + cost tracking) | 8.5  | ✅ livré |
| 3      | S26 – S27 | **Voix Jarvis + TikTok temps réel + Arbo Dropbox** (dogfooding mère, cf. D6) | 11   | en cours |
| 4      | S28 – S29 | PME pilote vraie (identification + déploiement + onboarding live + LUKS) — décalé depuis Sprint 3 | 7.5 |
| 5      | S30 – S31 | Boucle retour pilote + tests + a11y + anonymisation PII opt-in     | 10.5 |
| 6      | S32 – S33 | 4 features Claude.ai (Cowork V2 + onglet Code + Pennylane MCP + bouton "Demander à Claude") | 12.5 |
| 7      | S34 – S35 | Tracker auto features Claude + DNS updates + 2e PME                | 7    |

**Amendement 2026-05-25** (cf. `docs/DECISIONS.md` § D6) : Sprint 3 initialement "PME pilote" est devenu "Voix Jarvis + TikTok + Arbo Dropbox". Le glissement décale d'1 cran toute la suite de la roadmap. L'hypothèse critique "1 PME signée Q3" est assumée comme glissée à Q3-Q4.

## Sprint 1 — détail (livré 2026-05-24)

| #   | Item                                                                                       | État        | Référence        |
|-----|--------------------------------------------------------------------------------------------|-------------|------------------|
| 1.1 | Commit/push fixes session voix (VAD Silero + barge-in) + coder PrivateTmp                  | ✅ Livré     | PR #5            |
| 1.2 | Persister cette roadmap dans le repo                                                       | ✅ Livré     | ce fichier       |
| 1.3 | Brancher `updates.` / `install.` / `docs.` dans Caddy (DNS propagés)                       | ✅ Livré     | PR #6            |
| 1.4 | Vider les warnings svelte-check cockpit (a11y dialog + autofocus + line-clamp)             | ✅ Livré     | PR #6            |
| 1.5 | Mettre à jour `docs/STATUS.md` post-Sprint 1                                               | ✅ Livré     | PR #6            |
| 1.6 | Valider que `galaxia-coder.service` tourne après le fix EROFS                              | ✅ Vérifié   | (clone éphémère OK 2026-05-24 09:08, `coder/2026-05-24-veille-filter-keywords` pushed) |

## Sprint 2 — détail (livré 2026-05-24)

| #   | Item                                                  | État        | Référence |
|-----|-------------------------------------------------------|-------------|-----------|
| 2.A | Schema multi-user + migration + user_id scoping       | ✅ Livré    | PR #8     |
| 2.B | Abstraction mail provider (Brevo + Console)            | ✅ Livré    | PR #9     |
| 2.C | Endpoints magic link + UI login                       | ✅ Livré    | PR #10    |
| 2.D | Cost tracking par appel Anthropic                     | ✅ Livré    | PR #11    |

**Décisions tranchées en cours d'implémentation (à valider par Jeff) :**
- Allow-list silencieuse pour magic link (pas d'enum d'emails par un attaquant).
- Login UI : email primary, password admin caché derrière toggle "↓ Connexion administrateur".
- `MAIL_PROVIDER=console` par défaut (sûr en CI et dev). Bascule `brevo` en prod PME quand D1 sera tranchée.
- Pas encore d'UI admin pour ajouter des users (pour l'instant : SQL direct). À transformer en CLI ou page admin avant le pilote PME.

**Découverte importante (pour D3)** : un message "Bonjour, réponds OK" sous Opus = **$0.174** (11k input tokens du system prompt + memory + tools). Sous Sonnet ce serait ~5× moins. Argument concret pour basculer le default LLM.

## Sprint 3 — détail (en cours, 2026-05-25 → 2026-06-07)

**Thème :** Voix Jarvis + TikTok temps réel + Arbo Dropbox — dogfooding galaxie mère (cf. `docs/DECISIONS.md` § D6).

Ordre validé par Jeff : **A → C → B**.

| #   | Item                                                                 | Effort | État    | Cible       |
|-----|----------------------------------------------------------------------|--------|---------|-------------|
| 3.A1 | Porcupine WASM (wake word custom "Hey Galaxia") dans `+page.svelte`, remplacer regex actuelle | 1 j  | À faire | mère        |
| 3.A2 | Daemon Kyutai TTS (port 5501), basculement `ttsBackend = 'kyutai'`, fallback Piper conservé | 2 j  | À faire | mère (GPU)  |
| 3.A3 | Daemon Kyutai STT + WebSocket partial transcripts, fallback Web Speech | 2 j  | À faire | mère (GPU)  |
| 3.C1 | Bot Telegram : décodage immédiat TikTok à la réception (Whisper + Claude) au lieu d'inbox.md attendre 06:00 | 1 j  | À faire | mère        |
| 3.C2 | ACK Telegram enrichi (brief + lien profond cockpit `?c=<id>&voice=1` vers conv vocale pré-chargée) | 1 j  | À faire | mère        |
| 3.B1 | Migration SQLite : table `folders` (id, user_id, parent_id, name), colonnes `folder_id` sur conversations + documents | 1,5 j | À faire | mère+filles |
| 3.B2 | Composant `FolderTree.svelte` sidebar (drag-drop natif HTML5), routes `/folders/[id]`, breadcrumbs | 2,5 j | À faire | mère+filles |

**Total : 11 j-h** (capa nominale Sprint 3 = 7,5 j-h → débord sur Sprint 4).

**Pré-requis externes** :
- Accès **Picovoice Console** (compte gratuit) pour entraîner le modèle wake word custom "Hey Galaxia" → fichier `.ppn` à copier dans `apps/cockpit/static/wake/`. Tier perso suffit pour le mode dogfooding-mère.
- **GPU sur galaxie mère** (Hetzner GPU dédié ou équivalent) pour héberger Kyutai STT 1B + TTS 1.6B. Sinon fallback Pocket TTS CPU + Web Speech STT (qualité dégradée).

**Décisions inchangées dans ce sprint** :
- LUKS (planifié initialement Sprint 3) → repoussé en Sprint 4 avec le pilote PME (cohérent : le chiffrement disque a peu de valeur sans PME pour le démontrer).
- Stack voix : Picovoice Porcupine + Kyutai STT/TTS + cascade STT→Claude→TTS (pas Moshi e2e, pas mature).

Suivi détaillé des sprints suivants dans `docs/STATUS.md` (priorisé) et dans `QUESTIONS_POUR_JEFF.md` (questions ouvertes).

## 5 décisions structurantes à arbitrer (bloque Sprint 2-3)

| #  | Décision                  | Reco du consortium                                                                  | Statut    |
|----|---------------------------|-------------------------------------------------------------------------------------|-----------|
| D1 | Provider mail magic link  | **Brevo** (FR, freemium 300/jour)                                                   | À trancher (Jeff) |
| D2 | Identification PME pilote | (a) Réseau perso Jeff — alerte si pas de candidat à fin S25                         | À trancher (Jeff) |
| D3 | Default LLM               | **Sonnet** + bouton "Opus" et "Local" opt-in par message                            | À trancher (Jeff) |
| D4 | Refonte cockpit V2        | **Conditionnel** — aucun trigger objectif atteint aujourd'hui (1680 LOC, 0 bug bloquant, 0 PME) | ✅ Tranchée 2026-05-25 (D6) : GO mère-only pour Sprint 3 (voix + arbo) |
| D5 | Voix Pipecat/Whisper Q3 ? | **NON**, garder V1 Web Speech — replan Q4 après retour pilote                        | ✅ Tranchée 2026-05-25 (D6) : OUI mère-only Sprint 3, filles PME Q4 |

Quand Jeff tranche une décision, déplacer le bloc vers `docs/DECISIONS.md`.

## 8 anti-patterns formellement interdits Q3

1. ~~Refonte big-bang cockpit (sans trigger objectif)~~ — **neutralisé Sprint 3 par D6 (mère-only)** ; reste valable Sprints 4+
2. Course aux features Claude.ai (cap = 4 en Q3)
3. Sur-ingénierie sécurité avant retour terrain
4. Intégration outils nouveaux non validés (Pi reste OUT)
5. Refactor sans test préalable
6. Décisions business dans le chat (→ `QUESTIONS_POUR_JEFF.md`)
7. Multiplication LLM providers UI (max 3 : Local / Sonnet / Opus)
8. ~~Voix premium pendant Q3~~ — **neutralisé Sprint 3 par D6 (mère-only dogfooding)** ; rollout filles PME repoussé Q4

Si un sprint propose d'enfreindre un de ces patterns (hors exceptions documentées ci-dessus), refuser et reposer la question à Jeff dans `QUESTIONS_POUR_JEFF.md`.

## Mécanisme d'amélioration continue (post-Q3)

- **Hebdo automatisable** :
  - Lundi veille → 3 issues triées
  - Mardi coder agent → PR si < 1 j-h
  - Vendredi `weekly-status.sh`
- **Mensuel humain** (30 min) : Jeff arbitre **accélère / stabilise / coupe**.
- **Trimestriel** : relancer un consortium type "Tour 6" (synthèse de 9 sous-agents).
- **Scoring formel** d'un item candidat : `(Impact × Cohérence) / (Effort + Risque) > 0.5`.

## Hypothèse critique sur laquelle TOUT repose

> "Une PME pilote signera en Sprint 3 (S26-S27)."

Si Jeff ne trouve pas de candidat en juin, les Sprints 4-5-6 deviennent du dev spéculatif.

**Plan secours** (à formaliser quand on s'approche de la date) :
- **Date butoir** : 2026-06-21 (fin S25).
- **Si pas de PME identifiée à cette date** : bascule Sprint 3 sur (a) dogfooding Jeff intensif et (b) démarchage actif (linkedin / réseau / cold mail).
