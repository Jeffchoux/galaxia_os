# Projet `restaurant` — manifeste

> **Nom de code : « restaurant ».** La cible réelle est plus large : tous les
> **petits commerces de proximité** (restaurants, plombiers, artisans, agences
> immobilières, points de vente…).

## Ce que c'est

Un **business autonome à part entière**, **distinct du produit Galaxia**. Il ne
vend pas Galaxia et n'est pas un service Galaxia. Il **utilise la puissance de
Galaxia comme moteur interne** — le VPS, tous les LLM disponibles (Ollama, Groq,
Claude), les connaissances, les mémoires, les patterns d'agents éprouvés — pour
faire tourner un business construit de A à Z.

## Le modèle

1. **Découverte** — les agents trouvent des petits commerces via des sources
   publiques (OpenStreetMap / Overpass, fiches publiques) et les qualifient
   (adresse e-mail générique, faits vérifiables).
2. **Génération** — pour chaque commerce, un **site vitrine propre** est généré
   automatiquement à partir de faits vérifiés.
3. **Approche** — un e-mail est envoyé avec **un seul lien à cliquer** : le
   commerçant découvre **son** site, déjà prêt.
4. **Conversion** — s'il veut garder le site en ligne : **10 €/mois**. Sans
   abonnement, le site est **retiré des serveurs** au bout d'une courte période
   (≈ 1 semaine à 1 mois).

## Le principe fondateur

**Aucun humain ne travaille dessus.** Le business est piloté **à 100 % par des
agents IA**, qui **créent / « embauchent » autant d'agents que nécessaire** (cf.
les rôles dans [`agents/`](agents/) et le modèle dans
[`docs/05_AGENT_MODEL.md`](docs/05_AGENT_MODEL.md)). Le rôle de Jeff se limite
aux **décisions non codables** (légal, paiement, domaine d'envoi) — voir plus bas.

## Rapport à Galaxia (à ne pas confondre)

- **Plan business** : projet séparé, sa propre raison d'être, ses propres revenus.
- **Plan infrastructure** : il **s'appuie** sur Galaxia (VPS OpenJeff, LLM,
  systemd, SQLite, Caddy, patterns d'agents). Il existe donc un **couplage de
  réputation** via l'infra et le domaine d'envoi : c'est pourquoi l'envoi réel
  passera par un **domaine d'envoi dédié** (jamais `app.galaxia-os.com`), pour ne
  pas brûler la réputation de Galaxia.

## État actuel

- **Anneau 0 + Anneau 1 mergés** sur `main` (découverte OSM/Overpass +
  enrichissement Ollama).
- **Dry-run total** : aucun e-mail réellement envoyé, aucun paiement, aucun site
  publié. Les e-mails sont écrits sur disque ([`logs/dry_run_emails/`](logs/)).

## Ce qui bloque le passage à l'envoi réel

4 décisions **non codables** (réservées à Jeff), suivies dans
[`QUESTIONS_POUR_JEFF.md` § 15](../../QUESTIONS_POUR_JEFF.md) :

1. Domaine d'envoi dédié + prestataire e-mail souverain.
2. Base légale de la prospection (cible France, adresses génériques, opt-out 1 clic).
3. Paiement (Stripe, abonnement 10 €/mois).
4. Adresse postale physique de l'expéditeur (obligation légale e-mail commercial).

## Documentation

Détail technique dans [`docs/`](docs/) : `00` inventaire → `01` analyse critique
→ `02` architecture → `03` sources de données → `04` infrastructure → `05` modèle
d'agents → `06` modèle de base de données → `07` modèle de coût → `08` opérations
quotidiennes → `09` rapport d'implémentation.

---
*Cadre fondateur confirmé par Jeff le 2026-05-31.*
