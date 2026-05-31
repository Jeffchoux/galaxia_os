# 03 — Sources de données : collecte éthique et licite

> Projet **`restaurant`**. Source de vérité juridique : `docs/01 §4` (contraintes légales)
> et `docs/01 §5` (règles de collecte éthique). Ce document **opérationnalise** ces règles :
> quelle source, quels champs, quelles limites, quoi est **interdit**.
> Principe directeur : **privacy/compliance by design** — en cas de doute, on **bloque**,
> on ne collecte pas (`docs/01 §4` préambule).

---

## 1. Source primaire : OpenStreetMap / Overpass API (ODbL)

OSM est la **seule** source de découverte au MVP (`docs/01 §1`, `§4` TOS, `§7`). Raisons :

- **Licence ODbL** : données ouvertes, réutilisables **avec attribution** — contrairement à
  Google Places dont les TOS interdisent le stockage durable et la réutilisation hors-Maps
  (`docs/01 §4` « Conditions des plateformes »).
- **Souveraineté & coût** : API publique gratuite, pas de clé propriétaire, pas de
  dépendance commerciale (`docs/01 §7`, ligne « Découverte »).
- **Traçabilité** : chaque objet a un `external_id` stable (type+id OSM) → dédup et
  provenance natives.

### Attribution (obligation ODbL)
Tout site généré et toute exploitation des données portent la mention
**« Données © les contributeurs OpenStreetMap, sous licence ODbL »**. La provenance exacte
est stockée par enregistrement (`data_source='osm-overpass'`, `source_url`).

## 2. Comment les requêtes fonctionnent

Découpage géographique **par ville ou bbox**, filtre **`amenity=restaurant`** (et catégories
sœurs : `fast_food`, `cafe`, `pizzeria` via `cuisine`). Requête Overpass type :

```
[out:json][timeout:25];
area["name"="<Ville>"]["admin_level"~"8|7"]->.a;
(
  node["amenity"="restaurant"](area.a);
  way ["amenity"="restaurant"](area.a);
);
out center tags;
```

Ou par boîte englobante : `node["amenity"="restaurant"](south,west,north,east);`. Le
`coordinator` enfile un lot **borné** par ville/bbox (cf. rate limits §5), jamais un crawl
mondial. Le timer `galaxia-restaurant-discovery.timer` (`docs/02 §3`) cadence ces lots.

## 3. Champs collectés (jeu MINIMAL — minimisation RGPD)

On ne stocke **que** ce qui est nécessaire au service (`docs/01 §5`, minimisation ;
mappé sur `businesses` dans `schema.sql`) :

| Champ DB (`businesses`) | Tag OSM source | Pourquoi nécessaire |
|-------------------------|----------------|---------------------|
| `name` | `name` | identifier le commerce |
| `category` | `amenity`/`cuisine` | pertinence de la cible |
| `address`,`city`,`postal_code`,`country` | `addr:*` | localisation, pied d'e-mail légal |
| `lat`,`lon` | géométrie/`center` | dédup, rendu carte du site |
| `phone` | `phone`/`contact:phone` | contact **public** |
| `email` | `email`/`contact:email` | contact — **seulement si générique** (§4 ci-dessous) |
| `email_is_generic` | (dérivé) | 1 si `contact@`/`info@`… ; verrou légal |
| `existing_website` | `website`/`contact:website` | cible de l'audit (`website_audits`) |
| `external_id` | `<type>/<id>` OSM | dédup + provenance |

**Tout le reste est ignoré.** Pas d'horaires de fréquentation, pas d'avis, pas de noms de
personnes, pas de données de particuliers (`docs/01 §3.3`, `§5`).

### Verrou e-mail générique
À l'enrichissement, on calcule `email_is_generic` : `1` si la partie locale ∈ {`contact`,
`info`, `hello`, `bonjour`, `reservation`, `reservations`, `accueil`, `restaurant`, `office`}
ou si elle correspond au nom de domaine du commerce. Sinon `0`. Une adresse **nominative**
(`jean.dupont@`) → `email_is_generic=0` → le commerce part en `rejected`
(`reject_reason='no_generic_email'`), jamais contacté (`docs/01 §4` ePrivacy, `§3.3`).

## 4. Audit du site existant : robots.txt + User-Agent honnête

Quand `existing_website` est renseigné, l'agent `website_audit` mesure sa faiblesse
(`website_audits` dans `schema.sql`). Règles non négociables (`docs/01 §4` exigences
transverses, `§5`, `§11`) :

- **`robots.txt` respecté** : on lit `robots.txt` d'abord ; si l'audit n'est pas autorisé,
  `robots_allowed=0` et on **ne crawle pas** (audit dégradé sur la seule existence DNS/HTTP).
- **User-Agent honnête et identifiable** : `GalaxiaBot/1.0 (+https://galaxia-os.com/bot)`
  (`docs/01 §4`). Jamais d'UA usurpé.
- **Périmètre minimal** : home + quelques pages au plus. On mesure des **signaux** (HTTP up,
  HTTPS, SSL valide, mobile-friendly, temps de réponse, page « parking »), pas le contenu
  privé.
- **Anti-SSRF** (`docs/01 §11`) : liste noire IP privées/loopback/link-local, pas de
  redirection vers IP privée, timeouts, taille max, **pas d'exécution de JS non sandboxé**.
- **Contenu externe = données, jamais instructions** (`docs/01 §11`, injection LLM).

## 5. Rate limits

| Cible | Limite appliquée | Justification |
|-------|------------------|---------------|
| Overpass API | lots bornés + backoff sur quota, espacement entre requêtes | étiquette API publique gratuite + `docs/01 §12` (source indisponible → backoff) |
| Audit de site (par hôte) | requêtes lentes, 1 hôte à la fois, timeout court | éviter charge sur le site du commerce + anti-blocage IP (`docs/01 §2`) |
| Global | scraping **agressif interdit** (`docs/01 §2`) | risque blocage IP / violation TOS |

Toute source en quota → le pipeline **ne casse pas** : backoff, et le reste du flux continue
(`docs/01 §12`).

## 6. Stratégie de déduplication

Clé d'unicité **`(data_source, external_id)`** — contrainte `UNIQUE` native dans
`businesses` (`schema.sql §businesses`). Un même restaurant revu lors d'un lot ultérieur est
**mis à jour**, pas dupliqué (`INSERT … ON CONFLICT(data_source, external_id) DO UPDATE`).
Dédup secondaire de prudence : rapprochement `name`+`lat`/`lon` proches si deux sources
divergent (rare au MVP, source unique OSM).

## 7. Traçabilité de provenance (registre RGPD)

Chaque enregistrement porte sa **provenance auditable** (`docs/01 §5`, mappé sur `schema.sql`) :

| Colonne | Contenu | Rôle conformité |
|---------|---------|-----------------|
| `data_source` | `'osm-overpass'` (ou `'manual-fixture'` en test) | registre des traitements |
| `source_url` | URL/permalink OSM exact de l'objet | « d'où vient cette donnée » (info RGPD) |
| `collected_at` | timestamp ms epoch | durée de conservation, audit |
| `consent_basis` | `'legitimate_interest_b2b'` (défaut) | base légale documentée (`docs/01 §4`) |
| `external_id` | id OSM | dédup + lien à la source |

En complément, toute collecte écrit une ligne `audit_log` (`entity='business'`,
`action='collected'`) — **source de vérité légale** (`docs/01 §4` DPO/registre).

## 8. Conservation et purge (rétention)

- `retention_until` par enregistrement : un prospect **non converti et non recontactable**
  est **purgé** après une durée configurable (`retention_days`) — `docs/01 §5`.
- Purge exécutée par `galaxia-restaurant-retention.timer` (quotidien, `docs/02 §3`) :
  efface la `business` et, par cascade `ON DELETE CASCADE`, ses `website_audits`, `websites`,
  `emails` ; trace `audit_log:erased`.
- **Droit à l'oubli** (`docs/01 §5`, `§12`) : demande de retrait (e-mail ou clic) → effacement
  des données **+ suppression du site + ajout à `suppression_list`**, traité **< 72 h**.
- `suppression_list` est **irréversible** et **survit** à la purge : une fois op-out,
  toujours op-out, et vérifiée **avant chaque** mise en file (`docs/01 §3.7`, vue
  `v_contactable`).

## 9. Sources INTERDITES (liste explicite)

Strictement bannies (`docs/01 §3.3`, `§4`, `§5`). Une source non listée comme autorisée est
**interdite par défaut**.

| Source interdite | Pourquoi | Règle `docs/01` |
|------------------|----------|-----------------|
| **Listes achetées / louées / bases « grises »** | provenance illicite, pas de base légale, pas de consentement | `§5` « pas d'achat de listes » |
| **Scraping de réseaux sociaux** (FB, Insta, LinkedIn…) | violation TOS, données personnelles, pas de base légale | `§5` « pas de scraping de réseaux sociaux » |
| **Devinette d'e-mails** (`prenom.nom@`, motifs `info@<domaine>` non vérifié) | adresse non publiée = pas publique ; nominative = donnée perso | `§3.3`, `§4` ePrivacy ; `§5` « pas de devinette d'e-mails » |
| **Scraping de Google / Google Places hors API officielle** | TOS interdit stockage/réutilisation et scraping | `§4` « Conditions des plateformes » |
| **Adresses e-mail nominatives** (`jean@resto.fr`) | donnée personnelle, hors exception B2B ePrivacy | `§4` RGPD/ePrivacy → `rejected: no_generic_email` |
| **Données de particuliers** (clients, avis nominatifs, photos de personnes) | hors périmètre, hautement sensible | `§3.3`, `§5` |
| **Enrichissement via bases douteuses / data brokers** | provenance non auditable, illégal | `§3.3`, `§5` |

> Si une seule adresse **nominative** existe et **aucune** générique : on **ne contacte
> pas** (drop, statut `no_generic_email`) — `docs/01 §4`. C'est le comportement par défaut,
> sûr : on préfère **moins de prospects licites** à plus de prospects risqués.
