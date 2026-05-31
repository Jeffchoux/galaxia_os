# Décisions Galaxia

> Journal des choix tranchés. Les blocs viennent de
> [`../QUESTIONS_POUR_JEFF.md`](../QUESTIONS_POUR_JEFF.md) une fois résolus,
> avec la date et la réponse de Jeff. Lecture utile pour comprendre
> pourquoi le code/l'infra sont configurés comme ils sont.

---

## 2026-05-22 — Q1 : repo GitHub (partiellement)

**Posée le :** 2026-05-21
**Tranchée le :** 2026-05-22

**Décision** : repo GitHub = `https://github.com/Jeffchoux/galaxia_os.git`
(compte personnel de Jeff, nom `galaxia_os` avec underscore — différent du
domaine `galaxia-os.com` avec hyphen).

**Conséquence dans le code** :
- `git remote set-url origin git@github.com:Jeffchoux/galaxia_os.git`

**Suite** : la deploy key SSH générée précédemment (`galaxia_github_ed25519`)
**n'a pas accès** à ce repo — elle pointait vers un chemin imaginé `galaxia-os/galaxia` qui n'existe pas. Le push restera bloqué tant que Jeff
n'aura pas ajouté la clé publique aux **Settings → Deploy keys** du repo
`Jeffchoux/galaxia_os` avec **Read+Write**. Une note de suite reste
dans `QUESTIONS_POUR_JEFF.md` § Q1bis.

---

## 2026-05-22 — Q2 : n8n hérité du provisioning

**Posée le :** 2026-05-21
**Tranchée le :** 2026-05-22
**Réponse de Jeff** : « je ne sais pas »

**Décision** : container `n8n_n8n_1` **arrêté** sans destruction, volume `n8n_n8n_data` **conservé**, port UFW 5678 **fermé**. Réversible — si Jeff se souvient d'un usage actif, `cd /opt/n8n && docker-compose start` le réveille.

**Conséquence dans l'infra** :
- `docker stop n8n_n8n_1` (compose intact à `/opt/n8n/docker-compose.yml`)
- `ufw delete allow 5678/tcp` (sortie publique fermée)
- Volume Docker `n8n_n8n_data` préservé (~20 Mo, négligeable)

**Suivi** : si rien n'est réactivé d'ici fin juin 2026, supprimer définitivement (`docker-compose down -v && rm -rf /opt/n8n`).

---

## 2026-05-22 — Q8 : accès au dashboard NemoClaw

**Posée le :** 2026-05-22
**Tranchée le :** 2026-05-22
**Réponse de Jeff** : « tu décides je ne comprends rien »

**Décision** : **Option A par défaut** dans le wizard (`nemoclaw tunnel`, pattern natif), avec **migration prévue vers Option B** (Caddy + port-forward) quand la PME branche son propre domaine. Pas d'Option C (SSH tunnel) — trop technique pour le public manager non-dev.

**Pourquoi A par défaut** :
- Le wizard doit marcher en zéro config DNS — un manager non-tech ne sait pas configurer un enregistrement A
- `nemoclaw tunnel start` est le pattern natif NemoClaw → pas de glue code à maintenir
- Marche derrière NAT, firewall PME, ADSL résidentiel
- Souveraineté seulement entamée sur **l'accès UI** ; données, inférence et clés API restent locales (cf. modes confidentialité du briefing)

**Pourquoi B en cible** :
- Une fois la PME a un domaine + DNS, la dépendance Cloudflare disparaît
- Aligné avec le reste de la stack (Caddy déjà choisi pour `app.galaxia-os.com`)
- Le wizard détectera la présence d'un domaine et proposera la bascule

**Conséquences dans le code** :
- `scripts/install.sh` : ajouter étape « accès dashboard » avec choix A/B selon présence domaine
- Wizard interactif (FR) : par défaut A si pas de domaine, B si domaine fourni
- À documenter dans `docs/STACK.md` § Accès UI

**Suivi** : Q9 (bug plugin `nemoclaw`) reste ouverte mais non bloquante pour ce choix.

---

## 2026-05-22 — Q6 : stockage des clés API LLM côté PME

**Posée le :** 2026-05-22
**Tranchée le :** 2026-05-22 (autonomie : Jeff non bloquant, décision réversible)

**Décision** : **Option A** — fichier `.env` chmod 600 dans `/opt/galaxia/config/`, owner `galaxia`, une seule clé par installation (selon le provider choisi au wizard).

**Pourquoi A et pas B (pass/age) ni C (Ollama-only par défaut)** :
- **Simplicité de debug** : un manager non-tech peut ouvrir le fichier et vérifier sa clé, sans outil supplémentaire à apprendre
- **Pattern Docker-compose standard** : tous les services Galaxia liront ce `.env` via `env_file:` dans le compose — pas de glue secret-manager à écrire
- **Sécurité suffisante** : chmod 600 + owner non-root + machine PME mono-utilisateur ≈ même surface qu'un secret manager local. Le vrai risque est `git add .env`, mitigué par `.gitignore` + nommage explicite « secrets locaux » dans le header
- **C écarté** : forcer Ollama par défaut casse la promesse cloud du briefing, et le wizard doit collecter la clé au moment où le manager est devant son écran (sinon il oubliera)

**Conséquences dans le code** :
- `scripts/wizard.sh` § 3/4 : collecte la clé, écrit `${CONFIG_DIR}/.env` chmod 600
- `scripts/install.sh` : appelle le wizard avant `print_summary`
- `docker-compose.yml` (à venir) : déclarera `env_file: /opt/galaxia/config/.env` pour les services qui consomment des clés

**Suivi** : si une PME demande un secret manager (audit conformité, multi-utilisateurs), on peut basculer vers `age` ou `pass` plus tard sans casser le contrat — le wizard peut produire les deux formats. Pas de travail pré-emptif.

---

## 2026-05-22 — Architecture du wizard CLI manager-friendly

**Tranchée le :** 2026-05-22 (autonomie technique)

**Décision** : wizard FR séparé en `scripts/wizard.sh`, appelé par `install.sh` mais aussi exécutable seul (`sudo bash scripts/wizard.sh`).

**4 questions au manager** :
1. Mode confidentialité (cloud / hybride / 100% local)
2. Provider LLM (Claude / GPT / Gemini / Ollama) — filtré à Ollama si mode local
3. Clé API (skip si Ollama) — saisie masquée
4. Nom de domaine (optionnel, vide = tunnel Cloudflare auto)
+ bonus : mot-clé d'éveil (défaut « Hey Galaxia »)

**Mode dashboard auto-calculé** d'après le domaine (Q8) :
- domaine vide → `tunnel` (cloudflared natif NemoClaw)
- domaine fourni → `caddy` (reverse proxy + HTTPS auto)

**Sortie** :
- `${CONFIG_DIR}/galaxia.conf` — config publique, chmod 644
- `${CONFIG_DIR}/.env` — secrets, chmod 600, owner `galaxia`

**Modes** :
- **Interactif** (défaut) : pose les questions, valide par défaut « entrée »
- **Non-interactif** (`GALAXIA_NON_INTERACTIVE=1`) : pilote par env vars, fail si une réponse manque
- **Dry-run** (`GALAXIA_CONFIG_DIR=/tmp/...`) : permet de tester sans root et sans toucher `/opt/galaxia`

**Idempotence** : si `galaxia.conf` existe, affiche la config courante et demande « reconfigurer ? » (défaut non, backup sinon).

**Pourquoi script séparé et pas fonction dans install.sh** :
- Re-exécutable seul pour reconfigurer après coup (changer de provider LLM, brancher un domaine)
- Plus facile à tester (4 scénarios validés en non-interactif)
- Permet à une future UI web Galaxia d'écrire les mêmes fichiers via le même contrat

**Conventions UI tirées du test** : toute UI dans une fonction dont le `$(...)` est capturé doit aller à `>&2`, sinon la valeur retournée contient le banner. Voir `section()` et les `cat >&2 <<EXPLAIN` dans `wizard.sh`.

---

## 2026-05-25 — D6 : pivoter Sprint 3 vers Voix Jarvis + TikTok temps réel + Arbo Dropbox

**Posée le :** 2026-05-25
**Tranchée le :** 2026-05-25

**Décision** : combo **(d) + (a)**.

- **(a)** Amender la roadmap Q3 : **Sprint 3 = Voix Jarvis (A) + TikTok temps réel (C) + Arbo Dropbox (B)** (ordre A→C→B). PME pilote repoussée en Sprint 4. L'hypothèse critique "1 PME signée Q3" est assumée comme glissée à Q3-Q4.
- **(d)** Mode déploiement : **dogfooding galaxie mère seulement** dans un premier temps. Les filles PME tournent au minimum requis (Pocket TTS CPU, pas de GPU exigé) — règle du Hub & Spoke : la mère porte les coûts d'expérimentation.

**Conséquences immédiates dans la roadmap** :
- D4 (refonte cockpit V2) : passe de NO-GO à **GO conditionnel mère-only** pour les volets A+B
- D5 (voix Pipecat/Whisper Q3) : passe de NON à **OUI mère-only**, Q4 = roll-out filles PME une fois PME pilote signée et stack stabilisée
- Anti-patterns #1 (refonte big-bang cockpit) et #8 (voix premium Q3) : neutralisés pour Sprint 3 — la justification (commande directe du commanditaire après lecture des 4 options) figure ici. Restent valables pour les sprints suivants.

**Choix techniques validés en chat le 25/05** (sous-questions du plan voix) :
- **GPU** : galaxie mère oui (Hetzner GPU dédié, ~€200/mois), filles PME = CPU/Pocket TTS
- **Ordre des volets Sprint 3** : A (Voix) → C (TikTok temps réel) → B (Arbo)

**Stack voix retenue** (sur la base de la recherche état de l'art mai 2026) :

| Brique | Choix | Justification |
|---|---|---|
| Wake word browser | **Picovoice Porcupine WASM** (custom "Hey Galaxia") | Standard 2026, intégration ~3 lignes, FR supporté ; mode dogfooding-mère = tier perso suffit |
| STT streaming FR | **Kyutai STT 1B en_fr** (open-source, France) | Latence ~500ms, conçu agents, souveraineté ✅ |
| TTS FR (galaxie mère) | **Kyutai TTS 1.6B** GPU | TTFA 220ms, qualité française nettement supérieure à Piper |
| TTS FR (filles PME) | **Kyutai Pocket TTS** (CPU 100M params) | Tourne sur VPS sans GPU, FR supporté depuis avril 2026 |
| Full-duplex | Cascade STT→Claude→TTS (pas Moshi) | Moshi pas prêt prod (score adhérence instructions 1,26/5) ; cascade reste plus fiable mai 2026 |
| Orchestration éventuelle | Pipecat (BSD-2) en option de repli | Self-host pur, swap STT/TTS faciles ; non requis V1 |

**Plan Sprint 3 chiffré** :

| Volet | Description | Effort | Cible |
|---|---|---|---|
| A.1 | Porcupine WASM (wake word "Hey Galaxia") dans `+page.svelte` | 1 j | mère |
| A.2 | Daemon Kyutai TTS (port 5501), basculement transparent depuis `/api/tts` (3ᵉ option à côté de browser/piper) | 2 j | mère (GPU) |
| A.3 | Daemon Kyutai STT serveur + WebSocket partial transcripts, fallback Web Speech | 2 j | mère (GPU) |
| C.1 | Bot Telegram → décodage immédiat TikTok à la réception (Whisper + Claude) au lieu d'inbox.md | 1 j | mère |
| C.2 | ACK Telegram enrichi (brief + bouton lien profond cockpit vers conv vocale pré-chargée) | 1 j | mère |
| B.1 | Migration SQLite : table `folders`, colonnes `folder_id` sur conversations + documents | 1,5 j | mère + filles |
| B.2 | Composant `FolderTree.svelte` sidebar (drag-drop natif HTML5) + routes `/folders/[id]` | 2,5 j | mère + filles |

**Total : 11 j-h** (capa nominale Sprint 3 = 7,5 j-h → débord d'un sprint, donc Sprint 3 + début Sprint 4. La PME pilote glisse à mi-Sprint 4 / Sprint 5).

**Risque assumé** : si une opportunité PME apparaît à court terme (butoir D2 = 2026-06-21), arbitrage à refaire à ce moment — la voix Jarvis devient alors un argument vendeur mais le déploiement reste à finaliser.

---

## 2026-05-25 — D7 : STT serveur — faster-whisper au lieu de Kyutai STT (sur CPU)

**Posée le :** 2026-05-25 (en cours d'implémentation Sprint 3 § A.3)
**Tranchée le :** 2026-05-25 (autonomie technique, Jeff non bloquant)

**Décision** : pour le Sprint 3 § A.3, **remplacer Kyutai STT 1B en_fr (prévu en D6) par faster-whisper + large-v3-turbo int8** comme STT serveur. Endpoint POST `/api/stt` proxy un daemon FastAPI local (`galaxia-whisper.service`, port 5502). Si daemon down → 503 → client retombe sur Web Speech navigateur.

**Pourquoi cette déviation par rapport à D6** :

- Le plus petit modèle Kyutai STT publié mai 2026 = `stt-1b-en_fr` (1 milliard de paramètres), pensé GPU H100/L40S — aucune variante < 1B documentée, aucun benchmark CPU officiel.
- Ce VPS galaxie mère n'a **pas de GPU réel** (Virtio uniquement). Le procurement Hetzner GPU dédié validé en D6 n'est pas encore concrétisé.
- faster-whisper + large-v3-turbo int8 sur 8 vCPU : **RTF ≈ 1.21** mesuré sur ce VPS pour un échantillon FR de 5s (= 6s de transcription pour 5s de parole). Turn-based viable, qualité française correcte.
- Le distill EN-only (`distil-large-v3`) catastrophique en FR (test reproduit) → écarté.
- `medium` (RTF 0.86) plus rapide mais qualité légèrement inférieure → réservé à un éventuel mode "économe" plus tard.

**Architecture du remplaçant (pour swap futur sans toucher au cockpit)** :

- Daemon FastAPI exposant `POST /transcribe` multipart (`audio`, `language`) → JSON `{text, language, duration, latency_s}`.
- Variables d'env du service : `GALAXIA_STT_MODEL`, `GALAXIA_STT_DEVICE`, `GALAXIA_STT_COMPUTE`, `GALAXIA_STT_LANG`.
- Quand le GPU mère arrive : changer `GALAXIA_STT_MODEL=large-v3` (ou autre) + `GALAXIA_STT_DEVICE=cuda` + `GALAXIA_STT_COMPUTE=float16` dans le service. Zéro changement cockpit.
- venv `tts-venv` partagé avec galaxia-kyutai-tts.service (torch + ctranslate2 + tokenizers en commun) → ~5 Go économisés.

**Côté client (cockpit)** :

- Nouvelle option `sttBackend = 'whisper'` à côté de `'browser'` (toggle 🎤 Whisper / 🎙 Web).
- Silero VAD déjà en place fournit `onSpeechEnd(audio: Float32Array)` (PCM 16 kHz mono) → encodé WAV inline (44 octets header + int16 LE) → POST `/api/stt`.
- Wake-word regex / Porcupine respectés (même filtre côté Whisper que côté Web Speech).
- Voice mode hands-free : auto-send après transcription, identique au mode Web Speech.

**Risque assumé** : la latence STT Whisper sur CPU (~RTF 1.2) ajoute environ +20% de "lag perceptible" vs Web Speech qui est quasi instantané. Pour une conversation Jarvis fluide, on viendra y remettre Kyutai STT ou large-v3 GPU plus tard.

**Ce qui reste vrai de D6** : stack TTS (Pocket TTS Kyutai sur CPU mère, A.2 livré PR #16) inchangée. Le pivot ne concerne **que** le STT serveur. Wake word (Porcupine, A.1 PR #14) inchangé.

---

## 2026-05-25 — D8 : OpenAI Realtime API comme 4ᵉ backend voix (mode non-souverain assumé)

**Posée le :** 2026-05-25 (demande explicite Jeff après test E2E Volet A)
**Tranchée le :** 2026-05-25 (Jeff : *"je veux avoir l'option d'échanger en cliquant sur cette technologie dans mon cockpit"*)

**Décision** : ajouter au cockpit mère un **4ᵉ choix** dans le cycle `ttsBackend` (Browser → Kyutai → Piper → **Realtime**) qui bascule la voix en mode **speech-to-speech bout-en-bout via OpenAI Realtime API** (`gpt-realtime`, WebRTC client). Quand Realtime est sélectionné, il prend le contrôle complet du flux voix : pas de Claude côté serveur, pas de Whisper, pas de Kyutai TTS — toute la conversation se passe avec GPT-4o-realtime côté OpenAI.

**Pourquoi cette décision** :

- Le 2026-05-25, Jeff a constaté une **latence totale de 12-15 s** par tour de parole en mode cascade CPU (Whisper STT 7s + Claude streaming 3-5s + Kyutai TTS 1s). C'est physiquement le plafond de la cascade CPU.
- Référence comparative : ChatGPT Advanced Voice Mode (GPT-4o-realtime sur GPU OpenAI, WebRTC bidirectionnel, modèle multimodal speech-to-speech) tourne autour de **300-500 ms** end-to-end. Inatteignable en cascade.
- Jeff valide assumer la **dépendance non-souveraine + coût pay-per-minute** sur la galaxie mère (son usage perso de dogfooding), en gardant le mode cascade comme défaut et option de repli si OpenAI tombe.

**Architecture côté serveur** :

- Endpoint SvelteKit `POST /api/realtime/session` (auth gate identique au reste du cockpit). Mint un `client_secret` éphémère via `POST https://api.openai.com/v1/realtime/sessions` (durée ~60 s, à usage unique). Renvoie au client : `{ client_secret, model, voice }`.
- Le system prompt Galaxia (identité, style, mémoire `memory.md`) est **injecté côté serveur** dans le `instructions` field de la session OpenAI — l'identité Galaxia reste préservée, le ton aussi.
- Variables d'env (`apps/cockpit/src/lib/server/env.ts`) : `OPENAI_API_KEY` (requis pour le mode Realtime, sinon endpoint 503), `OPENAI_REALTIME_MODEL` (défaut `gpt-realtime`), `OPENAI_REALTIME_VOICE` (défaut `alloy`).

**Architecture côté client** :

- Nouvelle lib `$lib/client/realtime.ts` : ouvre une `RTCPeerConnection`, attache le micro local + un `<audio>` distant pour la voix de retour, négocie SDP avec `https://api.openai.com/v1/realtime` en utilisant le `client_secret`.
- Toggle TTS étendu : `ttsBackend` ∈ `'browser' | 'kyutai' | 'piper' | 'realtime'`, persisté localStorage.
- Quand `ttsBackend === 'realtime'` : les toggles STT et wake word sont grisés (incompatibles avec le bout-en-bout) ; le bouton voix active la session Realtime au lieu du pipeline cascade.
- Barge-in natif (l'utilisateur peut couper la voix GPT-4o en parlant) — géré par le serveur OpenAI sans code custom.

**Coût observé (mai 2026, tarif `gpt-realtime`)** :

| Sens | $/M tokens | Tokens/min | $/min |
|---|---|---|---|
| Audio input (utilisateur parle, 100 ms = 1 token) | $32 | ~600 | $0.019 |
| Audio output (Galaxia parle, 50 ms = 1 token) | $64 | ~1200 | $0.077 |
| **Conversation 1 min (50/50)** | | | **~$0.10** |
| Avec caching system prompt | | | **~$0.30/min all-in production** |

Pour Jeff en dogfooding (10-30 min/jour) : entre **1 et 10 €/mois**.

**Cost tracking** : événements `response.done` Realtime contiennent `usage` (input_audio_tokens, output_audio_tokens). On les capture côté client et on les POST à `/api/usage/track` qui réutilise la table `usage` existante (modèle = `gpt-realtime`).

**Souveraineté / scope** :

- Mode Realtime **n'est pas activé** sur les filles PME (cockpits installés chez les clients). Il reste dispo en option à activer manuellement dans `.env` PME si une PME le veut, mais ce n'est pas le défaut.
- La cascade STT→Claude→TTS souveraine reste le défaut et reste la cible "production PME" jusqu'à arrivée d'un GPU mère qui ferait redescendre la latence cascade à ~3-5s (D7 prévoit déjà le swap par env var).

**Risque assumé** :

- Tout le trafic audio passe par OpenAI quand Realtime est actif. Pas pour usage PME.
- La clé `OPENAI_API_KEY` permet potentiellement d'accéder à d'autres endpoints (chat completions, etc.) — limiter via rate-limit côté OpenAI si la facturation dérape.
- Le `client_secret` éphémère est valable ~60 s ; pas de partage entre sessions.

**Ce qui ne change pas** :

- Cascade Galaxia complète (Claude + memory.md + tools MCP + Kyutai TTS + Whisper STT) reste le mode par défaut.
- D7 (Whisper CPU) reste valable, swap GPU futur identique.
- D6 reste l'orientation stratégique long terme (voix souveraine), D8 n'est qu'un complément optionnel.

---

## 2026-05-31 — Cowork autonome : on construit (renversement du « Cowork différé » du 2026-05-30)

**Posée le :** 2026-05-31 (demande explicite de Jeff)
**Tranchée le :** 2026-05-31

**Renversement assumé.** Le 2026-05-30, le mode « Cowork » du spec UI avait été
**différé** (« pas de backend de tâches à brancher pour l'instant — choix
Jeff », cf. [`STATUS.md`](STATUS.md) § « Thème clair terracotta »). Jeff a
tranché l'inverse ce jour : **on construit Cowork maintenant**, en version
**autonome** (objectif → plan → gate → exécution sandboxée → livrable).

**Trois choix validés avec Jeff :**

1. **L'orchestrateur est à la fois l'équipe de construction (« build-crew ») et
   une capacité produit permanente.** Le même moteur qui aide à bâtir Galaxia
   (décomposer un objectif en sous-tâches exécutées en parallèle) devient une
   fonctionnalité livrée du cockpit pour le manager PME. Pas un échafaudage
   jetable : un composant pérenne, packagé Hub & Spoke pour les filles.
2. **Flotte d'agents dès maintenant.** On ne se limite pas à un agent
   séquentiel : les sous-tâches indépendantes du DAG s'exécutent **en
   parallèle** (jusqu'à `COWORK_MAX_CONCURRENCY`), chacune dans son propre
   processus/conteneur.
3. **Sandbox Docker par tâche.** Chaque sous-tâche tourne dans un **conteneur
   Docker jetable et isolé** (`--rm --read-only --network=none --cap-drop=ALL
   --user 1000:1000`, seul `/workspace` monté), plutôt qu'un sous-processus à
   même l'hôte. Le rayon d'action d'une sous-tâche se limite à un espace de
   travail éphémère ; le kill-switch fait `docker kill`. Choix conforme à la
   posture souveraine et conservatrice de Galaxia.

**Garde-fou central conservé : le gate d'approbation humaine.** Les sous-tâches
`safe` et `mutating` avancent seules (la boîte est jetable) ; les
`consequential` (irréversibles, effet de bord réseau, envoi de message, PR,
déploiement, dépense) **forcent** une approbation humaine explicite et sont
`skipped` si jamais approuvées. On ne fait jamais une action à conséquence sans
un « oui » du manager.

**Politique modèle respectée :** planner + exécution en **gratuit/peu cher par
défaut** (`COWORK_PLANNER_MODEL` = `claude-sonnet-4-6`, `COWORK_EXEC_MODEL`
sonnet/groq), Opus seulement sur escalade explicite. Plafond de coût par tâche
`COWORK_MAX_USD_PER_TASK` (défaut 1,00 $), mime `GALAXIA_CODER_MAX_USD_PER_RUN`.

**Conséquences dans le code** (branche `feat/cockpit-cowork-autonomous`,
worktree `/home/galaxia/cowork-build`) :

- DB : tables `cowork_tasks` + `cowork_subtasks` + helpers dans
  `apps/cockpit/src/lib/server/db.ts`.
- API : routes `apps/cockpit/src/routes/api/cowork/…` (CRUD + SSE + approve +
  kill), scopées `locals.user`.
- Orchestrateur : `agents/cowork/orchestrator.mjs` (démon
  `galaxia-cowork.service`), schéma Zod du plan.
- Sandbox : `agents/cowork/sandbox/run-subtask.sh` + image
  `galaxia/cowork-sandbox`.
- UI : panneau Cowork dans `apps/cockpit/src/routes/+page.svelte` (bouton
  « 🤝 Cowork » réactivé).
- Doc : `docs/COWORK.md` (architecture complète).

**État :** code écrit sur la branche, **pas encore mergé, pas déployé,
vérification de bout en bout en attente** (intégration & build faits par
l'humain). Voir [`STATUS.md`](STATUS.md) § « Cowork autonome » et
[`COWORK.md`](COWORK.md).

---

## 2026-05-31 — Q15.1 : envoi e-mail restaurant — domaine + prestataire

**Posée le :** 2026-05-28
**Tranchée le :** 2026-05-31
**Provisionnée & vérifiée le :** 2026-05-31
**Réponse de Jeff** : sous-domaine de `galaxia-os.com` + **Scaleway TEM**.

**Décision** :
- **Domaine d'envoi** = un **sous-domaine dédié de `galaxia-os.com`** (proposé
  `mail.galaxia-os.com`, label exact à confirmer au moment de la config DNS) —
  **jamais** `app.galaxia-os.com`. La réputation d'envoi reste ainsi isolée du
  domaine applicatif. (Choix d'un sous-domaine plutôt qu'un domaine `.fr` séparé :
  gratuit et immédiat ; couplage de réputation accepté pour un volume modéré.)
- **Prestataire** = **Scaleway TEM** (Transactional Email), région `fr-par`,
  100 % UE / souverain (cohérent ADN Galaxia, anti-CLOUD Act). Démarrage quasi
  gratuit (300 mails/mois, puis 0,25 €/1000) ; **IP dédiée via le plan Scale**
  quand le volume le justifiera, pour maîtriser warm-up et réputation.

**Provisionnement — FAIT le 2026-05-31** (infra prête ; TOUJOURS en dry-run tant
que 15.2 / 15.4 non tranchées) :
- ✅ Compte Scaleway créé par Jeff + **clé API TEM** rangée dans
  `/opt/galaxia/config/.env` (`SCW_ACCESS_KEY`, `SCW_SECRET_KEY`,
  `SCW_DEFAULT_REGION=fr-par`, `SCW_DEFAULT_PROJECT_ID=c34acb1f-…`). Jamais
  committée. À rotater (a transité en clair). Expire 2027-05-31.
- ✅ Domaine d'envoi `mail.galaxia-os.com` déclaré dans TEM (domain id
  `8f719178-…`) ; **SPF + DKIM + DMARC + MX posés chez OVH** et domaine
  **`checked` / vérifié** par Scaleway (réputation initiale 100/100).
- ⏭️ **Reste à coder** : brancher l'`email_agent` sur l'API TEM (endpoint
  `transactional-email/v1alpha1/regions/fr-par/.../emails`), en **gardant
  `send_enabled:false`** — aucun envoi réel tant que 15.2 (base légale) et 15.4
  (adresse postale) ne sont pas réglées.

**Toujours ouvert dans §15 (conditions de l'envoi réel)** : 15.2 (base légale),
15.3 (Stripe), 15.4 (adresse postale).
