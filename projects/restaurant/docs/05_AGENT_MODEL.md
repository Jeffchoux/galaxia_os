# 05 — Modèle d'agents (architecture en profondeur)

> Projet **`restaurant`** — système multi-agents autonome 24/7.
> Détaille l'architecture des **19 rôles**, leur coordination **via la base**
> (table `tasks` + `businesses.status`), le **modèle de veto**, les **règles
> d'autonomie & d'escalade**, et la **carte agent → tables**.
> Source de vérité : `docs/00`, `docs/01` (§8), `database/schema.sql`. Ne pas contredire.

---

## 1. Principe de coordination

Aucun appel direct (pas de RPC) entre agents. Tout passe par **l'état partagé en base** :

- La table **`tasks`** est la file de travail (pattern `agents/telegram/tasks.py`).
  Chaque ligne = `{agent, business_id, payload(JSON), status, priority}`. Le **worker
  résident** claim atomiquement (`BEGIN IMMEDIATE`) une tâche `pending`, la passe
  `running`, l'exécute, puis `done | error | killed`.
- Le champ **`businesses.status`** est la machine à états du prospect. Un agent ne se
  déclenche que sur l'état attendu, fait son travail, met à jour `status`, et **enfile la
  ou les tâches suivantes**. C'est un pipeline événementiel piloté par l'état.
- Le **`coordinator`** ne « commande » pas : il **observe** les états/échéances et **crée
  les tâches** manquantes. Les agents transverses (compliance, qa, security, finance,
  monitoring, strategy) lisent l'état et **écrivent des verdicts** (statut, audit_log).

### Machine à états `businesses.status`

```
discovered → enriched → audited → qualified ──→ site_built → contacted → replied
                                      │                                      │
                                      └→ rejected           converted ←──────┤
                                                                  │          └→ lost
   (à tout moment, veto)  ──────────────────────────────────→ blocked
   (opt-out / takedown)   ──────────────────────────────────→ suppressed
```

- `rejected` : non pertinent (site déjà bon, pas d'e-mail générique…).
- `blocked` : **veto** compliance/qa — sortie gelée jusqu'à levée (humain ou correction).
- `suppressed` : opt-out / retrait — **terminal et irréversible**.

---

## 2. Les 19 rôles

> LLM : **Ollama `llama3.1:8b` = défaut** (local, gratuit). **Claude** headless seulement
> ad hoc (génération de site premium, raisonnement complexe). « — » = pas de LLM (code pur).
> Veto = peut poser `status = blocked` et empêcher publication/envoi.

| # | Agent | Mission (1 ligne) | Déclencheur | Entrées → Sorties | LLM | Veto |
|---|-------|-------------------|-------------|-------------------|-----|------|
| 1 | **coordinator** | Orchestre, applique les garde-fous, crée les tâches manquantes | timer + changements d'état | états `businesses`/`websites`/échéances → lignes `tasks` | — | non (mais bloque sur veto) |
| 2 | **discovery** | Trouve des restos à faible présence web (OSM/Overpass, ODbL) | timer découverte | requête zone → `businesses` (status `discovered`, provenance) | Ollama (tri/classif) | non |
| 3 | **enrichment** | Complète les infos **publiques minimales** + détecte e-mail générique | `status=discovered` | `businesses` partiel → champs complétés, `email_is_generic` | Ollama | non |
| 4 | **website_audit** | Note la faiblesse du site existant (ou absence) | `status=enriched` | URL site → `website_audits` (score, weakness), respecte robots.txt | Ollama | non |
| 5 | **content** | Rédige le contenu du site (gabarit neutre, pas d'allégation inventée) | `status=qualified` | infos vérifiées → blocs de texte | Ollama (défaut) / Claude (premium) | non |
| 6 | **design** | Choisit le gabarit / la déclinaison visuelle | content prêt | catégorie + contenu → `websites.template` | Ollama | non |
| 7 | **build** | Assemble le site statique (HTML/CSS), `noindex`, bandeau | design prêt | template + contenu → `websites.build_path` (status `built`) | — | non |
| 8 | **hosting** | Publie / retire les sites (TTL 7 j), purge les expirés | build prêt / timer purge | `websites.build_path` → publié Caddy, `expires_at`, purge `v_expired_sites` | — | non |
| 9 | **email** | Génère et enfile les e-mails outreach (**dry-run**, token unsub obligatoire) | `status=site_built` | business + site → `emails` (status `dry_run`) | Ollama | non |
| 10 | **reply** | Classe les réponses entrantes, rédige un **brouillon** (jamais d'envoi auto) | réponse reçue (Anneau 2) | `replies.raw_text` → `intent`, `draft_reply`, `needs_human=1` | Ollama | non |
| 11 | **sales** | Qualifie l'intérêt, pousse vers la conversion | `intent=interested` | `replies` → étapes de conversion | Ollama / Claude | non |
| 12 | **billing** | Abonnement + factures (Anneau 3, Stripe — pas de carte stockée) | conversion validée | `subscriptions` (Stripe ref) → `active` | — | non |
| 13 | **compliance** | RGPD/ePrivacy/CAN-SPAM, suppression list, provenance | avant chaque envoi/publication | e-mail/site → OK ou `blocked` + `suppression_list`/`audit_log` | Ollama (analyse) | **OUI** |
| 14 | **qa** | Vérifie chaque site/e-mail avant sortie (faits, unsub, noindex) | sortie `built`/`drafted` | site/e-mail → OK ou `blocked` (raison) | Ollama / Claude | **OUI** |
| 15 | **security** | Secrets, surface d'attaque (SSRF audit), abus de la file | continu / sur audit | requêtes, contenus → alertes, blocage IP privées | — | non (alerte → coordinator) |
| 16 | **finance** | Coûts, marge, unit economics, plafond LLM premium | timer | `agent_runs.cost_usd` → rapports coût, alerte plafond | — | non (alerte) |
| 17 | **monitoring** | Santé système, métriques, alertes (Ollama, disque, bounce) | timer fréquent | healthchecks, compteurs → alertes | — | non (alerte) |
| 18 | **strategy** | Priorisation, A/B des templates/messages, expansion verticale | timer lent | métriques globales → `tasks.priority`, plan | Ollama / Claude | non |
| 19 | **— (réservé : coordinator agit aussi comme superviseur d'escalade)** | Écrit dans `QUESTIONS_POUR_JEFF.md` sur blocage sérieux | sur veto persistant / risque | état bloqué → escalade humaine | — | non |

> Note : le rôle d'escalade (#19) est la facette « superviseur » du `coordinator` ; il est
> listé pour rendre explicite le canal humain. Les 18 rôles fonctionnels + cette facette
> couvrent les 19 rôles annoncés en `docs/01` §8.

---

## 3. Modèle de veto (compliance + qa)

Deux agents — et **seulement** ces deux — peuvent **bloquer une sortie** en posant un statut
`blocked` (sur `businesses`, `websites` ou `emails` selon l'objet) :

| Agent | Bloque quoi | Exemples de motifs (`blocked_reason` / `reject_reason`) |
|-------|-------------|----------------------------------------------------------|
| **compliance** | publication d'un site, mise en file d'un e-mail | `suppressed` (présent dans `suppression_list`), `no_generic_email`, `no_unsubscribe`, `missing_postal_address`, provenance illicite |
| **qa** | site avec infos non vérifiées, e-mail mal formé | `unverified_claim`, `missing_noindex`, `broken_unsubscribe_link`, rendu cassé |

Règles dures (issues de `docs/01` §3) :

1. Le `coordinator` **ne publie ni n'envoie jamais** sans OK explicite de compliance **et** qa.
2. La vérification **`suppression_list`** (COLLATE NOCASE) est **rejouée juste avant** chaque
   mise en file — le verdict n'est jamais mis en cache.
3. Un e-mail **sans `unsubscribe_token`** ou sans adresse postale ne peut **pas** quitter
   l'état `drafted` (contrainte applicative + veto qa/compliance).
4. Un veto est **journalisé** (`audit_log.action='blocked'`) et **réversible uniquement** par
   correction de la cause (ou décision humaine), jamais par contournement.
5. `suppressed` (opt-out/takedown) est un veto **terminal** : il ne se lève jamais.

---

## 4. Autonomie & escalade

Principe (CLAUDE.md + brief) : **décider en autonomie**, ne **bloquer/escalader** que sur
**risque sérieux légal / sécurité / financier / infra**. Tout le reste se tranche seul.

| Situation | Comportement |
|-----------|--------------|
| Choix de gabarit, ton d'e-mail, priorisation, A/B | **Autonome** (strategy/design/content décident) |
| Rejet d'un prospect non pertinent | **Autonome** (`status=rejected`, motif tracé) |
| Doute conformité (e-mail nominatif, source douteuse) | **Bloque par défaut** → `rejected`/`blocked`, jamais d'envoi risqué |
| Activer l'**envoi e-mail réel** (domaine, SPF/DKIM/DMARC) | **Escalade** → `QUESTIONS_POUR_JEFF.md` (décision business) |
| Brancher **Stripe** / facturation réelle | **Escalade** (PCI, TVA, CGV) |
| Dépassement du **plafond de coût** Claude premium | **Escalade** (finance alerte, coordinator gèle le premium) |
| Risque **sécurité** (SSRF, fuite secret, abus file) | security alerte → coordinator gèle l'agent concerné, **escalade** si sérieux |
| Pic **bounce/plainte spam** au-dessus du seuil | kill-switch envoi (auto) + **escalade** |

Mécanique d'escalade : le `coordinator` consigne une entrée datée et actionnable dans
**`QUESTIONS_POUR_JEFF.md`**, marque l'objet `blocked`, et **continue** le reste du pipeline
(le blocage est local au prospect/à l'action concernée, pas global). Tant qu'une question
d'envoi/paiement n'est pas tranchée, le système **reste en dry-run** — comportement par défaut sûr.

---

## 5. Carte agent → tables touchées (R=lecture, W=écriture)

| Agent | businesses | website_audits | websites | emails | replies | subscriptions | suppression_list | tasks | agent_runs | audit_log |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| coordinator | R | R | R | R | R | R | R | **W** | R | W |
| discovery | **W** | — | — | — | — | — | R | R/W | W | W |
| enrichment | **W** | — | — | — | — | — | R | R/W | W | W |
| website_audit | W | **W** | — | — | — | — | — | R/W | W | W |
| content | R | R | W | — | — | — | — | R/W | W | — |
| design | R | — | **W** | — | — | — | — | R/W | W | — |
| build | R | — | **W** | — | — | — | — | R/W | W | W |
| hosting | R | — | **W** | — | — | — | — | R/W | W | **W** |
| email | R | — | R | **W** | — | — | R | R/W | W | W |
| reply | R | — | — | R | **W** | — | R | R/W | W | W |
| sales | R | — | R | R | R | W | R | R/W | W | W |
| billing | R | — | W | — | — | **W** | — | R/W | W | **W** |
| compliance | **W** (blocked) | R | W (blocked) | **W** (blocked) | R | R | **W** | R | W | **W** |
| qa | W (blocked) | R | W (blocked) | W (blocked) | R | — | — | R | W | W |
| security | R | R | R | R | R | R | R | R | W | **W** |
| finance | R | — | R | R | — | R | — | R | **R** | W |
| monitoring | R | R | R | R | R | R | R | R | R | W |
| strategy | R | R | R | R | R | R | — | **W** (priority) | R | — |

Lecture clé :
- **Seuls** compliance et qa écrivent l'état `blocked` (colonne « blocked »).
- **Seul** compliance écrit dans `suppression_list` (l'opt-out passe par lui).
- **Tous** les agents qui exécutent du LLM écrivent leur coût dans `agent_runs`
  (`cost_usd=0` pour Ollama, > 0 pour Claude) — base du modèle de coût (`docs/06`).
- **`audit_log`** est alimenté à chaque action sensible (collecte, publication, mise en file,
  opt-out, blocage, effacement) — source de vérité RGPD (`docs/07`/`docs/08` pour l'exploitation).
- La file **`tasks`** est lue/écrite par presque tous : c'est le tissu de coordination.

---

## 6. Cycle de vie complet d'un prospect (résumé)

1. **discovery** insère un `business` (`discovered`, provenance OSM).
2. **enrichment** complète, détecte `email_is_generic` → `enriched`.
3. **website_audit** note la faiblesse → `audited` ; si site déjà bon → `rejected`.
4. **coordinator** qualifie (site faible + e-mail générique) → `qualified` (sinon `rejected`).
5. **content → design → build** produisent un site `built` (`noindex=1`, bandeau, dry-run).
6. **qa** + **compliance** valident → sinon `blocked`.
7. **hosting** publie (TTL 7 j) → `site_built`.
8. **email** génère l'outreach (`dry_run`, token unsub) ; **compliance** rejoue la
   suppression list juste avant ; sinon `blocked`.
9. (Anneau 2+) **reply** classe la réponse → brouillon ; **sales** qualifie → `replied`.
10. (Anneau 3) **billing** active l'abonnement Stripe → `converted` (sinon `lost`).
11. À tout moment : opt-out/takedown → **compliance** → `suppression_list` + `suppressed` +
    **hosting** retire le site < 72 h.

> Le code de ce livrable s'arrête à l'**Anneau 0** (dry-run) ; les agents/tables des anneaux
> suivants existent mais ne déclenchent aucun effet externe tant que Jeff n'a pas tranché les
> questions d'envoi/paiement (`QUESTIONS_POUR_JEFF.md`).
