# Galaxia — Vision produit

> **But.** Faire de Galaxia, pour un manager non-développeur, un outil **plus puissant et plus accessible** que Claude Code (chat + cowork + code) réunis — accessible aussi bien à la **voix** qu'à l'**écrit**, et sans dépendre d'un compte SaaS tiers pour exister.
>
> **Public visé.** Le manager qui n'écrit pas de code. Pas l'IT, pas le développeur, pas l'early-adopter Twitter. La cible non-négociable : « ma comptable de 54 ans à la PME peut-elle se servir de Galaxia sans m'appeler trois fois par semaine ? »

Ce document est un **cap stratégique**, pas une roadmap. Il dit où on va, pas en quelle semaine. La roadmap concrète vit dans [`STATUS.md`](STATUS.md).

---

## 1. Comparatif honnête avec Claude Code (au 2026-05)

Pour battre Claude Code, il faut d'abord savoir précisément ce qu'il fait bien.

| Capacité Claude Code               | État Galaxia (2026-05)                                 | Verdict             |
|------------------------------------|--------------------------------------------------------|---------------------|
| Chat texte avec Claude             | ❌ Pas d'interface chat dans Galaxia                   | À construire        |
| Cowork (objectif → plan → exécution autonome) | 🚧 En construction (2026-05-31) — orchestrateur + sandbox Docker, branche `feat/cockpit-cowork-autonomous`, pas encore déployé | **Différenciateur** |
| Édition de code (Read/Write/Edit)  | ✅ Existe (coder agent via SDK)                        | Sous-utilisé        |
| Multi-fichier, diff review         | ⚠️ Coder agent fait des PRs, pas de review live        | À étendre           |
| Voix (input/output)                | ❌ Aucune                                              | **Différenciateur** |
| Skills custom                      | ⚠️ Possible via Claude Agent SDK                       | À exposer           |
| Memory tool / état persistant      | ❌ Pas implémenté                                      | À construire        |
| MCP tools                          | ⚠️ Pas câblé côté Galaxia                              | À câbler            |
| Hub & Spoke (auto-update signé)    | ✅ POC complet (cosign + timer systemd)                | **Différenciateur** |
| Veille IA quotidienne native       | ✅ HN + GitHub + HF + arXiv → Ollama                   | **Différenciateur** |
| Auto-amélioration via PRs          | ✅ Coder agent fait des PRs daily                      | **Différenciateur** |
| Souveraineté (zero cloud-call)     | ✅ Mode 100% local Ollama                              | **Différenciateur** |
| Wizard d'install pour non-dev (FR) | ✅ 4 scénarios testés                                  | **Différenciateur** |
| CLI manager-friendly (`galaxia`)   | ✅ status/update/config/logs                           | **Différenciateur** |

**Ce que Claude Code fait mieux** (à rattraper) : la qualité de l'interface chat, la latence d'interaction, le polish général de l'UX, l'écosystème Skills et MCP, la confiance d'usage par défaut (déjà des millions d'utilisateurs).

**Ce que Galaxia fait mieux** (à amplifier) : l'auto-installation sans IT, la souveraineté complète, l'auto-amélioration sans intervention humaine, le packaging Hub & Spoke pour N PMEs identiques, et bientôt la **voix** + la **simplicité radicale** pensée pour le manager non-dev.

**Conclusion.** Galaxia ne battra pas Claude Code sur le terrain de Claude Code (CLI de dev sur Mac). Il le battra sur un terrain où Claude Code n'existe pas : **le poste de travail du manager PME, multimodal, souverain, qui s'auto-améliore tout seul.**

---

## 2. Les trois différenciateurs structurels

### 2.1. Souveraineté par défaut

Personne n'a son Claude Code chez soi. Tout le monde le loue à Anthropic. Galaxia, par construction, **tourne chez la PME**, sur son serveur, avec sa clé API (ou en 100 % local si elle le veut). C'est un trait que Claude Code ne peut **pas** copier sans renier son modèle. On en fait l'argument numéro un :

- Aucune donnée client ne quitte le serveur en mode 100 % local.
- En mode cloud anonymisé, les données sensibles sont remplacées avant l'envoi à l'API (Claude / GPT / Gemini au choix de la PME).
- Le wizard rend ce choix lisible en 30 secondes, sans jargon.

### 2.2. Auto-amélioration native

Claude Code dépend des releases Anthropic. Galaxia **se met à jour quotidiennement à partir de sa propre veille IA**, via le mécanisme Hub & Spoke (cf. [`UPDATES.md`](UPDATES.md)). La galaxie mère fait la veille, le coder ouvre des PRs, un humain merge, l'update signée descend sur les filles le lendemain. Aucune PME n'a à se demander « il faut que je mette à jour ? » — c'est continu.

Levier : à terme, **certains labels de PRs peuvent s'auto-merger** (`coder-docs`, `coder-typo`, `coder-test`) sans review humaine. Ça réduit la dépendance à l'humain dans la boucle pour les changements à risque zéro.

### 2.3. Multimodal (voix + écrit) — le différenciateur produit

Claude Code est terminal-only. Aucun manager non-dev ne s'identifie à un terminal. Galaxia doit avoir une **interface de travail** qui accepte indifféremment :

- **Voix** — wake word « Hey Galaxia » + dictée libre. Réponses audio synthétisées.
- **Écrit** — interface web sur `app.<pme-domain>` (ou tunnel Cloudflare en attendant que la PME ait son domaine).
- **Téléphone** — bonus : un numéro qui sonne quand on l'appelle, et c'est Galaxia qui répond (cf. le projet Lina pour BabyRun, hébergé en parallèle sur OpenJeff — c'est un avant-goût).

C'est là qu'on bat Claude Code : ouvrir Galaxia ne demande pas de savoir taper sur un clavier. Ouvrir Galaxia, c'est dire « Hey Galaxia, où en est-on sur le devis Dupont ? ». L'écrit reste disponible pour les cas où la voix ne convient pas (open space, sujet confidentiel, contenu à coller).

---

## 3. L'interface de travail (objectif produit)

Cible : **une seule page web, ouverte en plein écran sur l'ordinateur du manager, qui sert de cockpit toute la journée**. Pas de menu à 14 entrées. Pas de modal à fermer. Pas de chargement à attendre.

### 3.1. Layout (esquisse)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Hey Galaxia, on parle ?                          🎤 [ écoute ]      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Conversation en cours — visible en transcript live                  │
│  (voix + texte, scrollable, copiable, exportable)                    │
│                                                                      │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  [ Champ de saisie texte — alternative à la voix ]      [ Envoyer ] │
├──────────────────────────────────────────────────────────────────────┤
│  ☆ Projets actifs           📂 Documents          🔔 Notifications  │
│  • Devis Dupont (en cours) │ • Contrats          │ • 3 emails       │
│  • RH onboarding Pauline   │ • Comptabilité Q1   │ • 1 PR à review  │
│  • Site web v2             │ • CR réunions       │                  │
└──────────────────────────────────────────────────────────────────────┘
```

**Principes :**

1. **Le transcript est central**, comme dans un chat. Voix transcrite à gauche, réponses Galaxia à droite. Tout est texte sélectionnable.
2. **Une seule façon de démarrer une action** : parler, ou taper. Pas de bouton « nouvelle conversation », pas d'onglets — Galaxia comprend que tu changes de sujet quand tu changes de sujet.
3. **Les trois zones du bas** (Projets / Documents / Notifications) sont des accès rapides, pas des menus à parcourir. Cliquer = la conversation passe à ce contexte.

### 3.2. Wake word et flux voix

- Wake word configuré au wizard (« Hey Galaxia » par défaut, modifiable).
- Au déclenchement : feedback visuel **immédiat** (l'écran respire ou pulse, pour confirmer qu'on a été entendu) + audio (un bip court). Pas de latence > 200 ms sur ce feedback — c'est la confiance qui se joue.
- Transcription Whisper en local par défaut (Ollama compatible) ; cloud (OpenAI Whisper API ou équivalent) optionnel selon le mode confidentialité.
- Réponse vocale via TTS local (Piper, Coqui) en mode local, ou TTS cloud (ElevenLabs, OpenAI) en mode cloud.

### 3.3. Continuité

- Une conversation interrompue (manager part en réunion, ferme l'onglet) reprend où elle s'était arrêtée à la prochaine ouverture.
- L'état est persisté **chez la PME** (memory tool côté Galaxia, pas dans le cloud).
- Multi-device : ouvrir Galaxia sur le téléphone montre la même conversation que sur l'ordinateur. WebSocket ou polling court, pas de service tiers.

### 3.4. Mode « cowork »

Le manager donne un **objectif** (pas une commande pas-à-pas), et Galaxia
s'en charge **toute seule**, de bout en bout. L'architecture (en construction
depuis le 2026-05-31, détail dans [`COWORK.md`](COWORK.md)) :

- **PLAN** : un orchestrateur décompose l'objectif en un graphe (DAG) de
  sous-tâches ordonnées, chacune classée par niveau de risque.
- **GATE d'approbation humaine** : les étapes à **conséquence** (irréversibles,
  envoi de message, dépense, déploiement) **s'arrêtent** et attendent un « oui »
  explicite du manager ; les étapes sûres et contenues avancent seules.
- **EXÉCUTION sandboxée** : chaque sous-tâche tourne dans un **conteneur Docker
  jetable et isolé** (sans réseau par défaut), de sorte que le rayon d'action se
  limite à un espace de travail éphémère.
- **LIVRABLE** : Galaxia agrège les sorties en un résultat unique, suivi en
  direct dans le cockpit (streaming SSE, comme une conversation).

C'est le vrai concurrent de « Claude Code cowork », mais pensé pour le manager
non-dev : on ne pilote pas un terminal, on confie un objectif et on garde la
main sur le seul moment qui compte — l'approbation des actions à conséquence.
Cap conservé pour plus tard : un cowork **multimodal en direct** (écoute en
arrière-plan, observation d'écran opt-in via screenshare, édition « à 4 mains »
dictée par la voix), à empiler sur cette base autonome.

---

## 4. Les couches que Galaxia doit livrer pour cette UX

| Couche                       | État au 2026-05            | Ce qu'il faut construire                                       |
|------------------------------|----------------------------|----------------------------------------------------------------|
| Backend agent (OpenClaw + NemoClaw) | Installé sur OpenJeff      | OK — sandbox `galaxia-main` Ready                              |
| LLM (Claude / GPT / Gemini / Ollama) | Wizard configure          | OK — module client à écrire (suivre [`agents/coder`](../agents/coder)) |
| Veille + auto-amélioration   | Coder + Veille en prod     | OK                                                             |
| Memory tool (persistance)    | ❌                         | Skill Memory du SDK Claude + stockage SQLite côté PME          |
| MCP tools                    | ❌                         | Câbler un MCP local pour fichiers/email/calendrier/Slack       |
| Transcription voix (in)      | ❌                         | Whisper local (ggerganov/whisper.cpp) ou API selon mode        |
| Synthèse voix (out)          | ❌                         | Piper local ou ElevenLabs selon mode                           |
| Wake word                    | ❌                         | Picovoice Porcupine (local, gratuit jusqu'à 3 keywords)        |
| Interface web cockpit        | ❌ (juste un placeholder)  | SvelteKit ou Next.js, tournant chez la PME (port 3000 → Caddy) |
| Sync multi-device            | ❌                         | WebSocket simple, état serveur Galaxia                         |
| Cowork (screen + audio)      | ❌                         | API navigateur (getDisplayMedia, getUserMedia) — pas trivial  |

**Stratégie d'ordre.** On ne construit pas tout en parallèle. L'ordre proposé :

1. **Module client Claude** (le coder agent est le premier pas — la lib partagée se construit en généralisant son `index.mjs` quand un deuxième consommateur arrive).
2. **Memory + MCP** — Galaxia doit pouvoir se souvenir d'une conversation à l'autre avant d'avoir une voix.
3. **Interface web cockpit** — texte d'abord. La voix s'ajoutera dessus.
4. **Voix in/out + wake word** — quand l'écrit marche.
5. **Cowork** — dernier, parce que c'est le plus complexe et le plus optionnel.

---

## 5. Modèle économique (rappel et conséquences)

- **Core** open-source (probablement AGPLv3 — cf. Q5 dans [`../QUESTIONS_POUR_JEFF.md`](../QUESTIONS_POUR_JEFF.md)) : wizard, agents PME, voix, cockpit web, Memory, MCP, intégrations LLM, veille.
- **Modules premium** payants : SSO multi-utilisateur, audit RGPD, modules sectoriels (RH, compta, juridique, marketing), support prioritaire — cf. Q10.
- Revenus annexes : installation accompagnée, intégration sur mesure, formation, conseil.

**Conséquence pour la vision produit.** Le core gratuit doit être **excellent**, pas un teaser. C'est lui qui gagne la confiance de la PME et déclenche éventuellement l'achat d'un module premium. Si le core ressemble à un MVP, personne n'achète le premium.

---

## 6. Risques produit identifiés

| Risque                                                                | Mitigation                                                                                              |
|-----------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| Dépendance hard à OpenClaw (sorti il y a 4 mois, peut bouger).        | Adaptateur côté Galaxia pour swap vers LangGraph / Mastra / raw Ollama si OpenClaw casse — cf. critique Brief. |
| Latence voix → audio (Whisper local sur CPU est lent).                | Mode hybride : transcription cloud (rapide) + génération locale, sinon GPU optionnel chez la PME.       |
| Cowork via screenshare = sujet vie privée et sécurité majeur.         | Opt-in par session, jamais persistant, indicateur visuel permanent quand actif.                          |
| L'UX vocale crée une dépendance forte → si elle bug, l'usage s'arrête.| L'écrit doit toujours marcher seul. La voix est un ajout, jamais une obligation.                          |
| Le coder agent ouvre une PR cassée → casse la confiance.              | Tests CI obligatoires, label `coder` ouvre 1 PR à la fois, jamais d'auto-merge sur code (seulement docs/typo). |

---

## 7. Comment ce document évolue

Ce document est **stratégique**, pas opérationnel. Ne pas y mettre :
- des dates / deadlines (vivent dans GitHub Projects ou Linear)
- des décisions tactiques (vivent dans `docs/DECISIONS.md`)
- des questions ouvertes (vivent dans `QUESTIONS_POUR_JEFF.md`)
- des chantiers en cours (vivent dans `docs/STATUS.md`)

Le mettre à jour seulement quand le **cap** change. Au minimum une fois par trimestre, le relire et constater (ou pas) qu'on est toujours d'accord.
