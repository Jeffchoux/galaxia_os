# Étude — Paysage IA (mai 2026) & fermeture de la boucle « j'envoie → Galaxia s'améliore »

> Produite le **2026-05-29** à la demande de Jeff (session root), via une étude
> multi-agents : 5 chercheurs web (paysage IA) + 3 architectes + 1 jury + synthèse.
> Toutes les affirmations techniques sur l'état du repo ont été **vérifiées à la main**
> avant rédaction. Les affirmations issues de la recherche web sont marquées par leur
> niveau de confiance.

## Le constat de départ (pourquoi « on ne va pas droit au but »)

Les deux choses que Jeff veut existent déjà à ~80 %, mais **le fil entre elles n'est pas branché** :

- **App type Claude.ai multi-device** = le **Cockpit** (`app.galaxia-os.com`) : chat Claude streaming, voix, memory, MCP, cowork, documents, multi-user. ✅
- **Canal « j'envoie un truc depuis l'iPhone »** = le **bot Telegram** (`galaxia-bot`, actif). ✅
- **Boucle d'auto-amélioration** = veille (06:32) → agent **coder** (07:01) → PRs. ✅

**Le chaînon manquant (vérifié dans le code) :**

1. Le **digest** (06:00) transcrit/analyse ce que Jeff envoie et écrit un **brief** que **Jeff seul lit**. Le pipeline `process_inbox.py` **classe déjà** chaque item en `knowledge` / `galaxia-update` / `inspiration`, et **écrit déjà** les `galaxia-update` dans `~/.claude/galaxia/galaxia-updates/pending/`.
2. Mais l'agent **coder** ne lit **que** la veille auto (HN/GitHub/arXiv) — son `userPrompt` (`agents/coder/index.mjs`) est bâti uniquement depuis `filteredBody`. **Il ignore `pending/`.** Le pont est construit à moitié ; il manque le dernier mètre.
3. Bout de chaîne cassé : le coder ne peut pas créer de PR — `/opt/galaxia/config/.env` (lu par `galaxia-coder.service`) **ne contient pas de `GH_TOKEN`**. Vérifié.

État vérifié le 2026-05-29 : `pending/` existe et est **vide**, `applied/` existe (dédup par déplacement déjà anticipée). Les 4 derniers briefs ne contenaient que de l'`inspiration`, aucun `galaxia-update` → **la boucle sera silencieuse la plupart des jours, par nature.** La valeur arrivera par pointes.

---

## 1. Le paysage IA, filtré : ce qui change vraiment pour Galaxia

> Seulement ce qui modifie une décision, débloque une capacité ou crée un risque.

**À exploiter maintenant (gratuit ou quasi)**
- **Claude Opus 4.8 (sorti 28 mai)** — fenêtre 1M tokens par défaut, prix annoncé identique à 4.7. L'agent peut lire tout le code + logs + mémoire en un appel : utile à la boucle d'auto-amélioration. *(Le cockpit est déjà passé en défaut `claude-opus-4-8` côté `env.ts`.)*
- **Security plugin Claude Code** — garde-fou gratuit qui bloque les commits dangereux (secrets, suppressions). Pertinent pour un agent qui code seul. *(confiance moyenne — à confirmer à l'install)*
- **Cache diagnostics** — pour comprendre pourquoi les ~11k tokens de baseline du cockpit ne sont pas mis en cache et réduire la facture.

**En réserve (vrais leviers, pas pour tout de suite)**
- **Mémoire persistante des agents (beta)** — socle pour accumuler décisions/patterns de bugs avec rollback. Pertinent dans 2-3 mois.
- **MCP Tunnels + sandboxes auto-hébergés** — exposer les outils Galaxia sans ouvrir de port public, exécution sur le VPS. Colle à l'exigence de souveraineté.
- **Advisor Tool (Sonnet + Opus)** — quotidien sur Sonnet, consultation d'Opus sur les décisions importantes. C'est la décision D3 (modèle pas cher par défaut) rendue automatique.

**Confiance faible — ne pas bâtir dessus**
- **« Dreaming »** (l'agent qui relit ses sessions et s'auto-améliore) : c'est littéralement la vision Galaxia, **mais research preview, source à confiance moyenne**. À surveiller, pas à intégrer.
- **Dynamic Workflows / multiagent** (10-100+ sous-agents) : aligné avec l'auto-amélioration, **mais bien plus cher en tokens** et en preview. À tester en bac à sable.

**LLM chinois open-weight** — pertinent pour le mode 100 % local. À retenir : la famille **Qwen** (Alibaba) et **DeepSeek** restent les références open-weight pour le tool-use et le français acceptable ; des variantes petites (≈7-8B quantifiées) sont la cible réaliste pour un VPS **sans GPU, 16 GB RAM** (le VPS mère n'a pas de GPU — STT/TTS tournent déjà en int8 CPU). *(confiance moyenne sur les noms/tailles exacts des toutes dernières versions — à benchmarker sur la machine avant tout choix.)*

**OpenAI** (hors boucle, touche le Volet C voix) — nouveaux modèles voix temps réel (raisonnement + traduction live) ; l'ancienne API Realtime est dépréciée → la clé OpenAI Realtime de Galaxia devra migrer. Pas urgent cette semaine.

> **Correction d'une alerte du rapport brut :** la recherche signalait un risque de panne au 15 juin sur les anciens IDs `claude-sonnet-4` / `claude-opus-4`. **Vérification faite : le repo n'utilise aucun de ces IDs** (il est sur `4-6`/`4-7`/`4-8` + `haiku-4-5`). **Pas d'exposition.** Seules deux mentions de doc (`INSTALL-PME.md`, un `SKILL.md`) citent encore `opus-4-7` comme défaut — cosmétique, sans impact fonctionnel.

**Verdict de section :** rien dans l'actualité ne remplace le travail à faire. Les nouveautés *facilitent* la boucle, elles ne la *construisent* pas.

---

## 2. Comment Jeff envoie ses flux pour que Galaxia s'améliore seul

**Architecture recommandée par le jury : « Fil direct »** (la plus simple, la plus souveraine, zéro nouveau service, tout sur le VPS).

**Canaux d'entrée**
- **Telegram** (canal principal, déjà actif) : liens TikTok/X, documents PDF/MD/TXT, photos.
- **Email** : workaround immédiat = copier-coller le texte ou forwarder en `.txt` dans Telegram. Un vrai forward email IMAP automatique est un chantier optionnel (≈80 lignes, indépendant).

**Le triage (« est-ce intéressant ? ») — déjà à deux filtres**
1. **Au digest** : Claude classe en `knowledge` / `inspiration` / `galaxia-update`. Seul `galaxia-update` passe dans `pending/`.
2. **Au coder** : il rejette vite tout ce qui n'est pas traduisible en modif de code concrète.

**Ce qui se passe ensuite** : proposition retenue → **PR sur GitHub que Jeff valide**. Sinon, écartée. Rien n'est appliqué dans le dos.

**Contrôle & garde-fous**
- Tout passe par des **PR approuvées par Jeff**.
- Garde-fou structurel : les **galaxies filles PME ne s'auto-modifient JAMAIS** localement ; l'auto-amélioration vit **uniquement sur la mère**, updates signées (cosign) avant diffusion.
- Quand le signal sera régulier : ajouter une **notification Telegram de fin de boucle** (« ce matin : 2 PR créées depuis tes envois »).

---

## 3. Plan d'action chiffré (S = minutes / M = petit chantier / L = sprint)

| # | Chantier | Effort | Débloque |
|---|----------|--------|----------|
| **0** | **Fix `GH_TOKEN`** dans `/opt/galaxia/config/.env` (déjà branché au service coder). | **S** | **Tout.** Sans lui, aucune PR n'est créée. Débloqueur n°1. *(décision business : quel token — voir Q14)* |
| **1** | ~~Migration modèles avant 15 juin~~ → **vérifié, pas d'exposition.** | — | Rien à faire (sauf 2 mentions de doc cosmétiques). |
| **2** | **Brancher `pending/` sur le coder** (~15 lignes dans `index.mjs` : lire les `pending/*.md`, les injecter en priorité, `mv` atomique vers `applied/` **avant** l'appel LLM pour éviter le rejeu en cas de crash). | **S** | **Ferme la boucle.** Cœur de la demande. |
| **3** | **Activer le security plugin** Claude Code. | **S** | Garde-fou commits dangereux. |
| **4** | **Notif Telegram de fin de boucle** — quand `pending/` se remplit (≥2 items/sem pendant un mois). | **S/M** | Fin de la boîte noire. Conditionnel au signal. |
| **5** | **Forward email IMAP** — script ~80 lignes, indépendant. | **M** | Nouveau canal sans copier-coller. Optionnel. |
| **6** | **Cache diagnostics + Advisor Tool** | **M** | Réduction coûts + D3 automatique. |
| **7** | **Mémoire persistante / Dynamic Workflows / Dreaming** | **L** | Auto-amélioration nouvelle génération. Previews, plus cher — plus tard. |

**Séquence minimale pour fermer la boucle cette semaine : #0 → #2 → #3.** Tout en effort **S**.

## Risques à surveiller (du jury)
- **Signal souvent vide** : boucle silencieuse la plupart des jours = normal, pas un bug.
- **Whisper sur TikTok `/photo/`** : yt-dlp échoue, propositions vides → ajouter un guard (si description < 100 chars, skip sans appel LLM).
- **`GH_TOKEN` partagé avec `ANTHROPIC_API_KEY`** dans le même `.env` : vérifier le scope (`repo` seul idéalement).
- **Timing 06:00 → 07:01** : 61 min ; si le digest dépasse sur CPU, `pending/` est vide à 07:01. Vérifier les durées récentes du digest.
- **Dédup `pending/` → `applied/`** : `mv` atomique **en début** de run, pas en fin.

## Fichiers concernés (chemins absolus)
- Coder à modifier : `/home/galaxia/galaxia-project/agents/coder/index.mjs` (construction du `userPrompt`).
- Pipeline qui alimente déjà `pending/` : `/home/galaxia/.claude/galaxia/pipeline/process_inbox.py` (`write_galaxia_proposals`).
- Propositions : `/home/galaxia/.claude/galaxia/galaxia-updates/pending/` (+ `applied/`).
- Config service : `/opt/galaxia/config/.env` (lu par `galaxia-coder.service`).
