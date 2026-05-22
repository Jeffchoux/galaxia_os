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
