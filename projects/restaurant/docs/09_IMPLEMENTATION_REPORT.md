# 09 — Rapport d'implémentation

> Projet **`restaurant`** — système multi-agents autonome 24/7.
> Implémentation initiale (**Anneau 0 — dry-run total**), le **2026-05-28** (révisé 2026-05-31).
> Tout a été validé par exécution réelle sur OpenJeff. Aucun e-mail envoyé, aucun site
> publié publiquement, aucun paiement : c'est volontaire et c'est le comportement sûr par défaut.

## 0. Incrément 2 — runtime 24/7 + désinscription (2026-05-31, autonome)

Ajouté après le socle initial, **sans intervention humaine** et toujours en dry-run :

- **File de tâches** (`pipeline/tasks.py`) sur la table `tasks` (claim atomique
  `BEGIN IMMEDIATE`, priorités, statuts) — gabarit `agents/telegram/tasks.py`.
- **Worker résident** (`pipeline/worker.py`) : `serve()` (boucle systemd) + `drain()`
  (tests / ponctuel). Dispatch des étapes `discover` / `process` / `purge_expired`.
  Garde-fou : refus de tourner en config ambiguë (`dry_run=false` sans `send_enabled`).
- **Coordinator** (`pipeline/coordinator.py`) : planifie le cycle quotidien en file
  (purge des sites expirés, puis découverte→qualif→site→e-mail). Décision/exécution
  séparées, comme l'archi bot/worker Galaxia.
- **Désinscription & retrait** (`pipeline/unsubscribe.py`) — **le maillon de conformité,
  prérequis à tout envoi** : token → `suppression_list` (irréversible) + prospect
  `suppressed` ; retrait de site par slug. Idempotent.
- **Unités systemd inertes** (`ops/galaxia-restaurant-{worker.service,coordinator.service,coordinator.timer}`),
  durcies (`NoNewPrivileges`, `ProtectSystem`), **non installées** (commande d'install
  documentée en tête de fichier).
- **6 tests runtime** (`tests/test_runtime.py`) → **12/12 tests verts** au total. Cycle
  `coordinator → worker` vérifié : 2 tâches planifiées → 4 traitées → 2 contactés (dry-run),
  2 rejetés, file vidée, 0 erreur ; opt-out re-vérifié (un prospect supprimé n'est pas
  re-contacté même remis en file).

## 1. Résumé de ce qui a été créé

Un **socle complet, documenté et exécutable** pour le système, arrêté au stade dry-run :

- **Inventaire technique réel** de la stack Galaxia (doc `00`) + **analyse critique**
  exhaustive (doc `01`, 13 sections : faisable / risqué / à ne pas automatiser / RGPD &
  CAN-SPAM / collecte éthique / MVP sûr / infra / agents / DB / coûts / sécurité / pannes /
  plan). 7 docs d'architecture & d'exploitation (`02`–`08`).
- **Schéma de base SQLite** orienté conformité (provenance, base légale, liste de
  suppression irréversible, journal d'audit RGPD, TTL).
- **19 rôles d'agents** (`agents/*.md`, coordinator + 17 spécialistes — incl. coordinator
  comme orchestrateur) + **4 prompts système** (`prompts/*.md`).
- **Pipeline dry-run réellement exécutable** (Python pur stdlib, **zéro dépendance** —
  tourne même sans PyYAML ni accès réseau) : `discovery → audit/qualification → content →
  build (site statique) → email (écrit sur disque)`.
- **Site d'exemple** généré pour des restaurants fictifs + **e-mails d'exemple** avec
  désinscription, identité et adresse postale.
- **Scripts** : `bootstrap.sh`, `run_dry_pipeline.sh`, `healthcheck.sh`.
- **Tests** (`tests/test_pipeline.py`, stdlib unittest) couvrant les invariants de conformité.

## 2. Fichiers créés (livrables)

```
projects/restaurant/
├── docs/00..09_*.md                 # inventaire, analyse critique, archi, data, infra,
│                                    #   agents, DB, coûts, ops, ce rapport (10 docs)
├── config/default.yaml              # config SÛRE par défaut (dry_run:true, ring:0)
├── database/schema.sql              # schéma SQLite conformité-by-design
├── data/fixtures.json               # 4 restaurants FICTIFS (dont 2 cas de rejet)
├── agents/*.md                      # 18 fiches de rôle (coordinator + 17 spécialistes)
├── prompts/*.md                     # 4 prompts système
├── pipeline/                        # config, db, discovery, audit, content, build,
│                                    #   email_gen, run_dry  (Python stdlib)
├── templates/site/                  # gabarit HTML + CSS (noindex, bandeau, retrait)
├── scripts/                         # bootstrap, run_dry_pipeline, healthcheck
├── tests/test_pipeline.py           # 6 tests d'invariants
├── sites/<slug>/                    # SITES D'EXEMPLE générés (livrable de démo)
├── logs/dry_run_emails/*.txt        # E-MAILS D'EXEMPLE (livrable de démo)
└── .gitignore                       # exclut base/.env/secrets
```

## 3. Commandes pour lancer le dry-run

Depuis `projects/restaurant/` (interpréteur : venv galaxia ou `python3` système) :

```bash
bash scripts/bootstrap.sh          # initialise la base SQLite (idempotent)
bash scripts/run_dry_pipeline.sh   # déroule tout le pipeline dry-run + résumé
bash scripts/healthcheck.sh        # vérifie l'environnement et le mode sûr
python3 -m unittest discover -s tests   # lance les tests
python3 -m pipeline.run_dry --json # sortie machine
```

## 4. Validation — ce qui PASSE / ce qui ÉCHOUE

Exécuté réellement le 2026-05-31 sur OpenJeff (venv galaxia, **sans PyYAML** → parseur de
config de repli exercé) :

| # | Vérification demandée | Résultat |
|---|------------------------|----------|
| 1 | Lint (si dispo)        | ⚠️ pas de linter Python configuré dans le repo (pas de ruff/flake8). `python -m py_compile` sur tout `pipeline/` : **OK**. |
| 2 | Tests (si dispo)       | ✅ **6/6** tests unittest passent (`Ran 6 tests … OK`). |
| 3 | Run du dry-pipeline    | ✅ 4 découverts → **2 qualifiés**, **2 rejetés**, **2 sites**, **2 e-mails** écrits, **0 envoi**. |
| 4 | 1 site de resto fictif | ✅ 2 sites générés (`sites/le-petit-tournesol-tours/`, `sites/trattoria-da-marco-tours/`). |
| 5 | Le site build en local | ✅ `index.html` + `styles.css` valides, autoportants (ouvrables au navigateur). |
| 6 | E-mail contient l'unsubscribe | ✅ chaque e-mail porte `…/u/<token>` + adresse postale + identité expéditeur ; **test bloquant** vérifie token présent dans `body_text` ET `body_html`. |
| 7 | La suppression list marche | ✅ adresse supprimée → e-mail `status='blocked'` (`reason='suppressed'`) ; insensible à la casse (COLLATE NOCASE). |
| 8 | Aucun secret committé  | ✅ scan regex (clés sk-/ghp_/AKIA/PEM/…) : **rien** ; aucun `.env`/`.key`/`.pem` dans le projet ; `.gitignore` couvre base + secrets. |
| 9 | Cas limites            | ✅ rejet `no_generic_email` (adresse nominative) et `site_already_good` (site déjà correct) vérifiés par test. |

**Échecs / limites connus (assumés, non bloquants pour l'Anneau 0) :**
- Pas de linter Python dans le repo → non exécuté (compilation OK à la place).
- La découverte/audit **réseau** (Overpass, audit HTTP réel SSRF-safe) est volontairement
  `NotImplementedError` tant que `dry_run=true` — squelette documenté, pas activé.
- La génération de contenu est par **gabarit déterministe** (pas d'appel Ollama) pour rester
  reproductible et hors-ligne ; le branchement Ollama est prévu (config `llm`) mais non
  requis au MVP. Le champ « cuisine » d'exemple retombe sur la catégorie (donnée minimale
  réellement stockée), conforme au principe de minimisation.

## 5. Risques restants

- **Réputation e-mail** : aucun envoi tant que domaine dédié + SPF/DKIM/DMARC + prestataire
  transactionnel ne sont pas en place (jamais l'IP/le domaine de Galaxia). Voir doc `01` §4.
- **Juridique** : la base légale d'envoi B2B doit être validée par juridiction ciblée ;
  mentions légales / CGV / politique de confidentialité de l'offre 10 € à rédiger.
- **Hallucination de contenu** : maîtrisée par le principe « aucun fait inventé » + veto QA,
  mais à re-tester dès qu'un LLM rédige réellement le contenu.
- **SSRF** à l'activation de l'audit réseau : la parade (blocage IP privées, pas de redirect
  vers IP privée, timeouts) est spécifiée doc `01` §11 mais devra être implémentée et testée.
- **Paiement** : aucune manipulation d'argent sans Stripe conforme (Anneau 3).

## 6. Prochaines étapes autonomes

Dans l'ordre, sans intervention humaine requise tant qu'on reste en dry-run / interne :

1. **Brancher Ollama** dans `content.py` (reformulation neutre, toujours sans inventer de
   fait) + tracer le coût (0 €) dans `agent_runs`.
2. **Implémenter la découverte Overpass** (doc `03`) en lecture seule, rate-limitée, avec
   attribution ODbL — et tester sur une ville, données réelles, **toujours en dry-run**.
3. **Implémenter l'audit HTTP SSRF-safe** (doc `01` §11) + scoring réel.
4. **Worker résident + timers systemd** (`ops/`) calqués sur `galaxia-tg-worker` pour la
   boucle 24/7 (découverte quotidienne, purge des sites expirés via `v_expired_sites`).
5. **Page de désinscription / retrait** (endpoint qui écrit dans `suppression_list` et
   purge le site) — pré-requis technique à tout envoi.
6. **Préparer l'Anneau 1** : pousser les blocs de site en `/var/www/galaxia-restaurant-sites/`
   + vhost Caddy `try.galaxia-os.com` (noindex), **sans encore envoyer d'e-mail**.

Les décisions qui **bloquent** le passage à l'envoi réel (domaine d'envoi, prestataire,
base légale, Stripe, adresse postale) sont consignées dans `QUESTIONS_POUR_JEFF.md` à la
racine du repo — seul canal vers Jeff, conformément à `CLAUDE.md`. **Aucune n'empêche de
continuer le travail interne ci-dessus.**

---
*Conforme à la règle du brief : aucune question posée à l'humain dans le chat ; toutes les
décisions techniques ont été prises de façon autonome ; seuls les vrais bloquants
légaux/financiers/infra sont remontés par écrit.*
