# 01 — Analyse critique & autocritique (AVANT implémentation)

> Projet **`restaurant`** — généré et hébergé de bout en bout par Galaxia.
> Rédigé le **2026-05-28**. Ce document est volontairement sévère : il existe pour empêcher
> de coder une machine qui exposerait Jeff à un risque **légal, financier ou de réputation**.
> Décisions prises en autonomie (cf. règle du brief & CLAUDE.md) ; les vrais points
> bloquants sont listés en § 3 et § 13.

Rappel de l'objectif : un système 24/7 qui (1) découvre des restaurants à faible présence
web, (2) leur génère un site gratuit temporaire (7 j), (3) l'héberge, (4) les contacte par
e-mail, (5) gère les réponses, (6) convertit en abonnés payants à **10 €/$ / mois**.

---

## 1. Ce qui est techniquement possible MAINTENANT

Réaliste, avec la stack détectée (doc `00`), **sans nouvelle dépendance lourde** :

- ✅ **Découverte** de restaurants via sources **publiques et licites** : OpenStreetMap /
  Overpass API (données ouvertes ODbL, idéal souveraineté), annuaires ouverts. Google Places
  possible mais sous conditions de TOS strictes (voir § 4).
- ✅ **Audit de site** : détecter absence de site, HTTP non-HTTPS, mobile-hostile, lenteur,
  certif expiré, page « parking ». Faisable avec `requests` + heuristiques + Lighthouse/headless
  optionnel. Aucune donnée privée requise.
- ✅ **Génération de site statique** : template HTML/CSS responsive rempli par LLM
  (Ollama pour le texte de masse, `claude` pour la version premium). Sortie = dossier statique.
- ✅ **Hébergement temporaire** : Caddy `file_server` sert déjà des statiques + HTTPS auto.
  Un site = un dossier sous `/var/www/galaxia-restaurant-sites/{slug}/`. Coût marginal ~0.
- ✅ **Génération d'e-mails** : rédaction + personnalisation triviale pour un LLM.
- ✅ **File de tâches + orchestration 24/7** : table SQLite + worker résident + timers
  systemd. Pattern déjà en prod (`galaxia-tg-worker`).
- ✅ **Tracking opt-out / suppression** : table SQLite + endpoint de désinscription.
- ✅ **Dry-run complet** : tout le pipeline jusqu'à l'e-mail **écrit sur disque**, zéro envoi.

## 2. Ce qui est RISQUÉ (faisable mais à encadrer)

- ⚠️ **Envoi d'e-mails commerciaux à froid (cold outreach).** Techniquement simple,
  **juridiquement le point le plus sensible** (§ 4). Aucun MTA configuré ; envoyer depuis
  l'IP du VPS sans SPF/DKIM/DMARC = spam instantané + blacklist de l'IP (qui sert aussi
  `app.galaxia-os.com`). **Risque de réputation sur tout le domaine Galaxia.**
- ⚠️ **Scraping agressif** des sources (Google, annuaires) : risque de blocage IP, de
  violation de TOS, et de collecte excessive. À limiter en débit et en champ.
- ⚠️ **Génération de contenu par LLM** : risque d'**hallucination** (faux menu, faux horaires,
  fausse adresse, fausses allégations « meilleur resto de la ville »). Publier un site au nom
  d'un commerce avec des infos fausses = risque pour le commerce ET pour Galaxia.
- ⚠️ **Usage de la marque/du nom/des photos** du restaurant sans autorisation sur un site
  public indexable = risque de contrefaçon / droit à l'image / concurrence déloyale.
- ⚠️ **Réponses automatiques aux e-mails** : un agent qui répond seul peut promettre des
  choses fausses, mal négocier, ou s'engager juridiquement.
- ⚠️ **Facturation/paiement automatisé** : manipuler de l'argent → conformité PCI, TVA,
  mentions légales, droit de rétractation. À ne jamais bricoler.

## 3. Ce qui ne doit PAS être automatisé aveuglément (garde-fous durs)

1. **Aucun envoi d'e-mail réel au MVP.** Le système démarre et reste en **dry-run** tant
   que (a) un domaine d'envoi dédié + SPF/DKIM/DMARC ne sont pas en place, (b) une décision
   business explicite n'a pas activé l'envoi. → bloc dans `QUESTIONS_POUR_JEFF.md`.
2. **Aucune publication d'un site sur une URL publique indexable sans `noindex`** et sans
   mention claire « aperçu non officiel généré par Galaxia, non affilié — réclamez ou
   supprimez ce site ». Le site temporaire porte un bandeau + `robots: noindex` + lien de
   retrait en un clic (« ce n'est pas mon commerce / supprimez »).
3. **Aucune donnée personnelle au-delà du strictement public et professionnel.** Pas de
   données de particuliers, pas d'e-mails personnels devinés (pas de `prenom.nom@`), pas
   d'enrichissement via bases douteuses.
4. **Aucune affirmation factuelle inventée** sur le site : seules les infos vérifiables
   (récupérées de source publique) sont publiées ; tout le reste est du gabarit neutre, et
   le contenu « marketing » est explicitement générique/modifiable, jamais présenté comme
   un fait sur le commerce.
5. **Aucune réponse e-mail engageante envoyée sans validation humaine** au MVP : l'agent
   `reply` **rédige un brouillon** et le met en file ; un humain (ou une étape de validation)
   approuve avant envoi. Pas d'auto-négociation de prix.
6. **Aucun débit de carte automatique** sans prestataire de paiement conforme (Stripe ou
   équivalent) gérant PCI, mandats, factures et rétractation. Galaxia ne stocke **jamais**
   de numéro de carte.
7. **Respect absolu des opt-out / suppression list** : une adresse désinscrite ou ayant
   demandé le retrait n'est **plus jamais** recontactée, recheck obligatoire avant tout envoi.
8. **Rate limits** sur toutes les sources externes et sur l'envoi (quand activé).

## 4. Contraintes légales pour la prospection commerciale

> ⚠️ Ceci n'est pas un avis juridique. Le système est conçu pour le **respect par défaut**
> (privacy/compliance by design) et **bloque** plutôt que de prendre un risque légal.

### Cadre applicable
La cible étant des **restaurants** (et le projet hébergé en UE, IP française/allemande),
le cadre dominant est **européen** : **RGPD** + **directive ePrivacy** (transposée, ex.
France : art. L34-5 CPCE / LCEN). Pour toute cible US : **CAN-SPAM Act**. Le système doit
satisfaire **le plus strict des deux** (RGPD/ePrivacy).

### RGPD (UE)
- Une adresse e-mail professionnelle **nominative** (`jean@resto.fr`) est une **donnée
  personnelle**. Une adresse **générique** (`contact@resto.fr`, `info@`) l'est beaucoup
  moins → **on privilégie EXCLUSIVEMENT les adresses génériques de contact** publiées
  publiquement par le commerce.
- **Base légale** retenue : **intérêt légitime** (prospection B2B vers une adresse pro
  générique), strictement encadré et documenté (registre de traitement). Pas de catégorie
  spéciale, pas de profilage.
- **Obligations** implémentées : information claire (qui contacte, pourquoi, quelles
  données, d'où elles viennent — « source : votre fiche publique OSM/site »), **droit
  d'opposition / désinscription en 1 clic**, droit d'accès/effacement (l'opt-out efface),
  minimisation (§ 5), durée de conservation limitée, sécurité des données.
- **DPO / registre** : tenir un registre des traitements (champ `data_source` + `consent_basis`
  en base) et une politique de conservation (purge auto, § DB).

### ePrivacy (UE) — le point dur du cold email
- L'e-mail de prospection **non sollicité** à une personne physique exige en principe le
  **consentement préalable (opt-in)**. **Exception B2B** dans plusieurs pays (dont FR) :
  prospection autorisée vers une **personne morale** sur une adresse **générique
  professionnelle** si (a) l'objet est en rapport avec l'activité de la personne contactée
  (un site web pour un restaurant **l'est**), et (b) un **opt-out simple et gratuit** est
  fourni à chaque message.
  → **Décision :** on ne contacte **que** des adresses **génériques pro** (`contact@`,
  `info@`, `reservation@`, `hello@`), jamais une adresse nominative. Si seule une adresse
  nominative existe → **ne pas contacter** (drop, statut `no_generic_email`).

### CAN-SPAM (US) — si cibles US
- En-têtes non trompeurs, objet non trompeur, identification comme message commercial,
  **adresse postale physique valide** de l'expéditeur, **mécanisme d'opt-out fonctionnel
  honoré sous 10 jours ouvrés**. CAN-SPAM est **opt-out** (moins strict que l'UE) mais
  l'opt-out reste obligatoire et la suppression list aussi.

### Exigences techniques transverses (implémentées par défaut)
- **Lien de désinscription** dans **chaque** e-mail (token unique, page de confirmation,
  effet immédiat). ← vérifié par les tests.
- **Suppression list** persistante, vérifiée **avant chaque** mise en file d'envoi.
- **Adresse postale physique** de l'expéditeur dans le pied de chaque e-mail.
- **Identité claire** de l'expéditeur (qui, au nom de quoi) — pas d'usurpation.
- **Rate limits** d'envoi (réchauffe progressive du domaine), throttle par destinataire,
  un seul fil de relance (max N relances espacées, stop à l'opt-out ou à la réponse).
- **Tracking d'opt-out** horodaté et **irréversible** (une fois op-out, toujours opt-out).
- **Pas de pixel de tracking invasif** ni d'ouverture trackée sans base légale claire.

### Conditions des plateformes (TOS)
- **Google Places / Maps** : les TOS interdisent le stockage durable et la réutilisation
  hors-Maps de nombreux champs, et le scraping. → **OpenStreetMap/Overpass (ODbL)** est la
  source primaire (réutilisation libre avec attribution). Google n'est utilisé, le cas
  échéant, que dans le respect strict de l'API officielle et de ses quotas, jamais scrapé.
- **Respect des `robots.txt`** lors de l'audit de site (ne crawler que la home + quelques
  pages, identifiant `User-Agent` honnête `GalaxiaBot/1.0 (+https://galaxia-os.com/bot)`).

## 5. Règles de collecte de données éthique

- **Minimisation** : on ne collecte QUE les champs nécessaires au service — nom, catégorie,
  adresse, ville, **adresse e-mail générique publique**, téléphone public, URL du site
  existant (le cas échéant), signaux d'audit web. **Rien d'autre.**
- **Sources publiques et licites uniquement** : OSM/Overpass (ODbL), site web public du
  commerce, fiches publiques. Pas d'achat de listes, pas de bases grises, pas de scraping
  de réseaux sociaux, pas de devinette d'e-mails.
- **Provenance tracée** : chaque enregistrement stocke `data_source` + `collected_at` +
  l'URL d'origine. Auditable.
- **Pas de données personnelles de particuliers** (clients du resto, avis nominatifs, etc.).
- **Respect des robots.txt / rate limits** ; `User-Agent` identifiable et honnête.
- **Droit à l'oubli** : un commerce peut demander le retrait (e-mail ou clic) → effacement
  des données + suppression du site + ajout à la suppression list. Traité < 72 h.
- **Conservation limitée** : un prospect non converti et non recontactable est purgé après
  une durée définie (config `retention_days`).

## 6. Stratégie MVP plus sûre (recommandée)

Plutôt que « tout, autonome, tout de suite », on livre par **anneaux de risque croissant**,
chacun activable indépendamment par un drapeau de config :

**Anneau 0 — Dry-run total (CE QUE CE LIVRABLE IMPLÉMENTE)**
- Découverte (échantillon), audit, génération de site, génération d'e-mail → **tout sur
  disque**. `dry_run: true`. **Aucun envoi, aucune publication publique indexée, aucun
  paiement.** Sites consultables en local. E-mails écrits dans `logs/dry_run_emails/`.
- Objectif : prouver la chaîne complète + la conformité (unsubscribe, suppression, noindex)
  sans aucun risque externe.

**Anneau 1 — Hébergement réel + envoi manuel**
- Sites publiés sous `try.galaxia-os.com` avec `noindex` + bandeau + retrait 1-clic.
- E-mails générés mais **revue/approbation humaine** avant envoi ; envoi via un
  **prestataire transactionnel réputé** depuis un **domaine dédié** (pas l'IP/le domaine
  de Galaxia) avec SPF/DKIM/DMARC. Volumes faibles (réchauffe).

**Anneau 2 — Relances + réponses assistées**
- Séquence de relance bornée (max 2-3, opt-out/réponse = stop). L'agent `reply` **rédige**,
  un humain valide. Tracking opt-out actif.

**Anneau 3 — Conversion + facturation**
- Paiement via **Stripe** (ou équivalent) : Galaxia ne touche jamais la carte. Abonnement
  10 €/$ /mois, factures, TVA, rétractation gérés par le prestataire. Site basculé en
  permanent à l'activation de l'abonnement.

**Anneau 4 — Pleine autonomie surveillée**
- Levée progressive des validations humaines, sous métriques (taux de plainte spam < seuil,
  bounce < seuil), kill-switch global, supervision quotidienne (doc `08`).

> Le code de ce livrable s'arrête à l'**Anneau 0**, mais l'architecture (drapeaux, tables,
> agents) est prête pour activer les anneaux suivants sans refonte.

## 7. Choix d'infrastructure

| Besoin            | Choix MVP                              | Justification |
|-------------------|----------------------------------------|---------------|
| Langage           | Python 3.12 (venv galaxia)             | cohérent stack agents, riche en libs réseau |
| Base              | SQLite WAL (`data/restaurant.db`)      | aucune install, souverain, suffisant ; pattern `tg_tasks` déjà en prod |
| File de tâches    | table SQLite + worker résident         | pas de Redis à installer |
| Orchestration     | systemd timers + worker (`ops/*.service`) | aligné sur coder/veille/worker |
| LLM volume        | **Ollama `llama3.1:8b`** (local)       | gratuit, souverain, « pas de premium par défaut » |
| LLM site premium  | `claude` headless, ad hoc              | qualité finale, coût maîtrisé |
| Découverte        | OSM/Overpass (ODbL)                     | licite, réutilisable, gratuit |
| Génération site   | gabarit statique + remplissage LLM      | pas de framework, build trivial, hébergement statique |
| Hébergement       | **Caddy `file_server`** + HTTPS auto    | déjà actif, pattern éprouvé, coût ~0 |
| E-mail (Anneau 1+)| **prestataire transactionnel + domaine dédié** | ne JAMAIS brûler l'IP/domaine Galaxia |
| Paiement (Anneau 3)| **Stripe** (hors-PCI pour nous)        | conformité déléguée |
| Packaging fille   | Docker / compose                        | modèle Hub & Spoke |

## 8. Architecture d'agents (vue d'ensemble — détail doc `05`)

Un **coordinator** orchestre des agents spécialisés, chacun = un **rôle** (fichier `.md`
décrivant mission, entrées, sorties, garde-fous) exécuté par le runtime (Ollama/`claude`),
communiquant **via la base** (pas de RPC direct). 19 rôles :

`coordinator` (chef d'orchestre, décide, applique les garde-fous) →
`discovery` (trouve les restos) → `enrichment` (complète infos publiques) →
`website_audit` (note la faiblesse du site existant) → `content` (rédige le contenu) →
`design` (choisit gabarit/déclinaison) → `build` (assemble le site statique) →
`hosting` (publie/retire, TTL 7 j) → `email` (génère/file les e-mails, dry-run) →
`reply` (classe les réponses, rédige des brouillons) → `sales` (qualifie/convertit) →
`billing` (abonnement, factures — Anneau 3) → `compliance` (RGPD/CAN-SPAM, suppression,
veto) → `qa` (vérifie chaque site/e-mail avant sortie) → `security` (secrets, surface
d'attaque, abus) → `finance` (coûts, marge, unit economics) → `monitoring` (santé,
métriques, alertes) → `strategy` (priorisation, A/B, expansion verticale).

Chaque agent a un **droit de veto** matérialisé : `compliance` et `qa` peuvent bloquer une
sortie (statut `blocked` en base) ; le `coordinator` ne publie/n'envoie jamais sans leur OK.

## 9. Schéma de base de données (résumé — détail `database/schema.sql`)

Tables clés : `businesses` (prospects + provenance + base légale), `websites` (sites générés,
TTL, statut publication, noindex), `emails` (messages générés, dry-run, token unsub),
`suppression_list` (opt-out **irréversible**, vérifiée avant tout envoi), `tasks` (file
agents, pattern `tg_tasks`), `subscriptions` (Anneau 3), `events`/`audit_log` (traçabilité
RGPD), `agent_runs` (coûts/observabilité). Détail + DDL en SQL portable SQLite.

## 10. Estimation de coûts

Hypothèses : VPS déjà payé (coût marginal nul pour calcul/hébergement statique).

| Poste                        | Coût unitaire estimé | Note |
|------------------------------|----------------------|------|
| Hébergement d'un site statique| ~0 €                | Caddy + disque, négligeable |
| Découverte/audit (Ollama)    | 0 € (local)          | électricité seulement |
| Génération texte (Ollama)    | 0 € (local)          | |
| Génération site premium (Claude) | ~0,03–0,15 € / site | seulement si on monte en gamme ; sinon 0 via Ollama |
| E-mail transactionnel (Anneau 1+) | ~0,0003–0,001 € / e-mail | prestataire ; gratuit en dry-run |
| Domaine d'envoi dédié        | ~10–15 €/an          | one-shot |
| Stripe (Anneau 3)            | ~1,5 % + 0,25 € / paiement | sur 10 €/mois ≈ 0,40 € → marge ~9,60 € |
| **Coût marginal d'un prospect (dry-run)** | **≈ 0 €**   | tout local |
| **Coût d'un client converti / mois** | **< 1 €**     | hébergement + frais Stripe |

→ **Unit economics favorables** : à 10 €/mois, la marge brute par client est ~9 €/mois.
Le risque n'est pas le coût mais la **réputation** (spam) et le **juridique**. Le doc `06`
détaille les seuils (CAC implicite, point mort).

## 11. Risques de sécurité

- **SSRF / audit de site** : l'agent `website_audit` fait des requêtes vers des URLs
  arbitraires → risque SSRF (accès à `127.0.0.1`, métadonnées cloud). **Mitigation :**
  liste noire d'IP privées/loopback/link-local, pas de suivi de redirection vers IP privée,
  timeouts, taille max, pas d'exécution de JS non sandboxé.
- **Injection LLM** : un site/contenu hostile lu par l'audit peut contenir des instructions
  d'injection. **Mitigation :** le contenu externe est traité comme **données**, jamais
  comme instructions ; prompts avec séparateurs nets ; sorties LLM validées (schéma).
- **Fuite de secrets** : clés dans `/opt/galaxia/config/.env` (600). **Jamais** committées,
  jamais écrites dans un site/e-mail, jamais loguées. Test « no secret committed » en CI.
- **Hébergement de contenu** : ne pas devenir un hébergeur de contenu illicite ; sites
  générés par gabarit contrôlé, pas d'upload utilisateur, `noindex`, retrait 1-clic.
- **Abus de la file de tâches / RCE** : le worker exécute des actions ; périmètre limité,
  pas d'`eval` de contenu externe, droits Unix `galaxia` (pas root), `NoNewPrivileges`.
- **Spam / blacklist** : voir § 4 ; domaine dédié, réchauffe, seuils de plainte/bounce,
  kill-switch.
- **Détournement du lien d'unsubscribe** : token signé/aléatoire non devinable, action
  idempotente, pas de désinscription d'un tiers possible sans le token.

## 12. Scénarios de panne

| Scénario | Effet | Parade |
|----------|-------|--------|
| Ollama down | génération bloquée | healthcheck + retry + fallback file en attente, alerte monitoring |
| Source découverte indisponible/quota | pas de nouveaux prospects | backoff, sources multiples, le reste du pipeline continue |
| LLM hallucine une info | contenu faux publié | `qa` valide contre les données collectées ; contenu non vérifiable = gabarit neutre ; `noindex` |
| E-mail mal formé / sans unsubscribe | risque légal | test bloquant : pas d'e-mail mis en file sans token unsub + adresse postale |
| Pic de bounces / plaintes spam | blacklist domaine | seuils + kill-switch envoi automatique, pause + alerte |
| Worker plante en cours de tâche | tâche `running` orpheline | timeout dur + requeue, statut auditable, `Restart=on-failure` |
| DB corrompue / lock | pipeline figé | WAL + `BEGIN IMMEDIATE` + retries ; sauvegarde quotidienne |
| Disque plein (sites accumulés) | hébergement KO | TTL 7 j + purge auto + quota ; monitoring espace disque |
| Restaurant demande le retrait | obligation légale | retrait 1-clic + suppression list + purge < 72 h |
| Coût LLM premium dérive | facture | défaut Ollama, compteur de coûts (`agent_runs`), plafond config |

## 13. Plan d'exécution recommandé (final)

1. **Documentation & architecture** (docs `00`–`08`) — *fait dans ce livrable*.
2. **Schéma de base** (`database/schema.sql`) avec conformité intégrée (suppression list,
   provenance, base légale, audit) — *fait*.
3. **Fichiers de rôle des agents** (`agents/*.md`) + **prompts** (`prompts/*.md`) — *fait*.
4. **Pipeline dry-run minimal mais réellement exécutable** (`pipeline/`, Python) :
   discovery (échantillon/fixtures) → audit → content → build → email → **tout sur disque,
   `dry_run=true`** — *fait*.
5. **Site d'exemple** pour un restaurant fictif + **e-mails d'exemple** avec unsubscribe — *fait*.
6. **Validation** : lint (si dispo), tests, run du dry-pipeline, build du site local,
   vérif unsubscribe, vérif suppression list, vérif aucun secret committé — *fait, doc `09`*.
7. **Rapport d'implémentation** (`docs/09_IMPLEMENTATION_REPORT.md`) : ce qui passe / échoue.
8. **PR** (branche dédiée, jamais sur `main`) ; déploiement réel des anneaux 1+ = **décisions
   business** à poser dans `QUESTIONS_POUR_JEFF.md` (envoi e-mail, domaine dédié, Stripe).

### Points qui BLOQUENT le passage à l'envoi réel (à acter par Jeff, pas par l'agent)
> Conformément à la règle : on ne bloque que sur risque légal/sécurité/financier/infra sérieux.
- **Domaine d'envoi dédié + DNS (SPF/DKIM/DMARC)** et choix du prestataire transactionnel.
- **Validation de la base légale** d'envoi B2B pour les juridictions ciblées.
- **Compte Stripe** + mentions légales / CGV / politique de confidentialité de l'offre 10 €.
- **Adresse postale physique** à faire figurer dans les e-mails.

Ces points sont consignés dans `QUESTIONS_POUR_JEFF.md` (ajout par ce projet). Tant qu'ils
ne sont pas tranchés, le système **reste en dry-run** — c'est le comportement par défaut, sûr.
