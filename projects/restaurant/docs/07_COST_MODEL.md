# 07 — Modèle de coût & unit economics

> Projet **`restaurant`** — économie unitaire et **maîtrise des coûts**.
> Source de vérité : `docs/00` (§6 LLM, §12 synthèse), `docs/01` (§10 coûts),
> `database/schema.sql` (`agent_runs.cost_usd`). Chiffres = estimations de cadrage,
> pas une compta : ils servent à décider, pas à facturer.

Hypothèse fondatrice : le **VPS OpenJeff est déjà payé**. Le calcul, l'hébergement statique
(Caddy) et le LLM **local Ollama** ont donc un **coût marginal ≈ 0** (électricité seulement).
Politique Galaxia : **pas de modèle premium par défaut** — Ollama/Groq pour le volume,
Claude/Opus uniquement quand la qualité l'exige.

---

## 1. Coût marginal d'un prospect (pipeline dry-run)

Tout le pipeline découverte → audit → contenu → build → e-mail tourne en **local**.

| Poste | Modèle / ressource | Coût marginal | Note |
|-------|--------------------|---------------|------|
| Découverte (OSM/Overpass) | requête HTTP publique | ~0 € | source ODbL gratuite |
| Tri/classification | Ollama `llama3.1:8b` | **0 €** | local, `cost_usd=0` |
| Audit du site existant | `requests` + heuristiques + Ollama | **0 €** | local |
| Rédaction du contenu | Ollama (défaut) | **0 €** | local |
| Build du site statique | code pur (gabarit) | ~0 € | CPU négligeable |
| Hébergement (dry-run) | disque local | ~0 € | aucun envoi/publication |
| Génération de l'e-mail | Ollama | **0 €** | écrit dans `logs/dry_run_emails/` |
| **Total / prospect (dry-run, défaut Ollama)** | | **≈ 0 €** | tout local |
| Variante « site premium » | Claude headless (ad hoc) | **~0,03–0,15 €** | seulement si on monte en gamme |

> En **Anneau 0**, le coût de production d'un prospect complet (jusqu'à l'e-mail prêt) est
> **essentiellement nul**. Le seul coût variable possible est la **génération de site premium**
> via Claude, qui est **optionnelle** et **plafonnée** (§6).

---

## 2. Coût d'un client converti (par mois)

Une fois l'abonné à **10 €/$ / mois** (Anneau 3, Stripe) :

| Poste | Coût mensuel | Détail |
|-------|--------------|--------|
| Hébergement du site permanent | ~0 € | Caddy `file_server`, statique, marginal |
| E-mail transactionnel (cycle de vie) | ~0,001–0,01 € | quelques e-mails/mois via prestataire |
| **Frais Stripe** | **~0,40 €** | ~1,5 % + 0,25 € sur 10 € (estimation EU) |
| Support/maintenance amortie | négligeable au MVP | automatisé |
| **Coût total / client / mois** | **< 1 €** | dominé par Stripe |

### Marge

| Élément | Montant |
|---------|---------|
| Revenu / client / mois | **10,00 €** |
| Coût / client / mois | **~0,40–1,00 €** |
| **Marge brute / client / mois** | **~9,00–9,60 €** |
| Marge brute | **~90–96 %** |

> Les coûts **one-shot** d'acquisition d'un client (génération du site + e-mails) sont
> ≈ 0 € en Ollama, ou au plus quelques centimes en premium → amortis dès le **premier mois**.

---

## 3. Où apparaît le coût premium Claude

Le **seul** poste réellement payant côté LLM est la **génération de site premium** (agent
`content`/`qa` en mode Claude). Il est **opt-in** et **borné** :

| Levier | Valeur par défaut | Effet |
|--------|-------------------|-------|
| Modèle par défaut | **Ollama `llama3.1:8b`** | coût LLM = 0 |
| Premium Claude | **désactivé par défaut** (ad hoc) | activé seulement pour un sous-ensemble |
| Plafond de coût (config) | ex. `premium_daily_cap_usd` | au-delà → finance alerte, coordinator gèle le premium |
| Suivi | `agent_runs.cost_usd` par run | somme par jour/agent/modèle |

Tout run premium écrit son coût réel dans `agent_runs` (`model='claude:…'`, `cost_usd>0`),
ce qui rend la dérive **mesurable et bloquable** (§6).

---

## 4. Point mort (break-even)

Au MVP, les coûts **fixes** sont quasi nuls (VPS déjà payé, Ollama local). Les coûts
incrémentaux à l'envoi réel (Anneau 1+) sont faibles :

| Poste fixe / périodique | Coût | Cadence |
|-------------------------|------|---------|
| Domaine d'envoi dédié | ~10–15 € | / an |
| Prestataire e-mail transactionnel | 0 € (free tier) → ~10–20 € | / mois selon volume |
| (VPS) | déjà payé | — |

| Hypothèse de coûts fixes mensuels | Clients pour le point mort (à ~9,2 € de marge) |
|-----------------------------------|-----------------------------------------------|
| ~0 € (Anneau 0, tout local) | **0** (pas de coût à couvrir) |
| ~2 € / mois (domaine amorti) | **1 client** |
| ~10 € / mois (prestataire e-mail) | **2 clients** |
| ~20 € / mois (volume + premium) | **3 clients** |

> Conclusion : **2 à 3 clients payants** suffisent à couvrir l'intégralité des coûts
> récurrents d'exploitation à l'échelle MVP. Le facteur limitant n'est pas le coût mais la
> **réputation** (spam) et le **juridique** (`docs/01` §4).

---

## 5. Sensibilité : Ollama vs Claude pour la génération de site

Pour 1 000 sites générés (campagne) :

| Scénario | Modèle génération | Coût / site | Coût 1 000 sites | Qualité | Décision |
|----------|-------------------|-------------|------------------|---------|----------|
| A — défaut | Ollama `llama3.1:8b` | **0 €** | **0 €** | correcte (gabarit neutre) | **défaut** |
| B — hybride | Ollama, Claude sur top prospects (10 %) | ~0,008 € moy. | **~8 €** | élevée sur les meilleurs | recommandé à l'échelle |
| C — premium | Claude sur tous | ~0,03–0,15 € | **~30–150 €** | maximale | seulement si ROI prouvé |

| Si conversion = 2 % de 1 000 | Revenu mensuel récurrent | Coût génération one-shot | Verdict |
|------------------------------|--------------------------|--------------------------|---------|
| Scénario A | 20 clients × 9,2 € = **~184 €/mois** | 0 € | marge maximale |
| Scénario B | idem ~184 €/mois | ~8 € one-shot | amorti en heures |
| Scénario C | idem (si conv. identique) | ~30–150 € one-shot | n'a de sens que si le premium **améliore** la conversion |

> Le premium ne se justifie **que** s'il déplace le taux de conversion ou de réponse —
> à mesurer en A/B par l'agent `strategy`. Par défaut : **Ollama partout** (scénario A).

---

## 6. Garde-fous de coût (récapitulatif)

| Garde-fou | Implémentation | Effet |
|-----------|----------------|-------|
| **Ollama par défaut** | tous les agents pointent Ollama sauf override explicite | coût LLM = 0 par défaut |
| **Suivi par run** | `agent_runs(model, input_tokens, output_tokens, cost_usd, duration_ms)` | coût mesurable par agent/jour/modèle |
| **Plafond premium** | config `premium_daily_cap_usd` (et/ou par campagne) | au-delà : alerte finance + gel du premium par coordinator |
| **Premium ciblé** | activé seulement sur top prospects (strategy) | dépense concentrée là où le ROI existe |
| **Hébergement statique** | Caddy `file_server`, TTL 7 j + purge | pas de coût compute/stockage qui dérive |
| **Dry-run par défaut** | `emails.dry_run`/`websites.dry_run = 1` | zéro coût d'envoi tant que non activé |
| **Pas de carte stockée** | Stripe gère le paiement | pas de coût/risque PCI |

Requête type (coût LLM des 24 dernières heures, par agent/modèle) — à exécuter sur
`restaurant.db` (détail commandes en `docs/08`) :

```sql
SELECT agent, model,
       COUNT(*)              AS runs,
       SUM(input_tokens)     AS in_tok,
       SUM(output_tokens)    AS out_tok,
       ROUND(SUM(cost_usd),4) AS cost_usd
FROM agent_runs
WHERE created_at > (CAST(strftime('%s','now') AS INTEGER) - 86400) * 1000
GROUP BY agent, model
ORDER BY cost_usd DESC;
```

> Attendu en régime normal : la quasi-totalité des lignes en `ollama:llama3.1:8b` avec
> `cost_usd = 0`. Toute ligne `claude:…` avec un coût non nul doit rester **sous le plafond**.

---

## 7. Synthèse pour décideur

- **Acquisition** d'un prospect : **≈ 0 €** (tout local, dry-run).
- **Coût récurrent** d'un client : **< 1 €/mois** (Stripe domine).
- **Marge** : **~9 €/client/mois (~90 %+)**.
- **Point mort** : **2–3 clients** couvrent les coûts récurrents d'exploitation.
- **Risque coût** : uniquement le **premium Claude**, neutralisé par défaut Ollama +
  suivi `agent_runs` + plafond config.
- Le vrai risque du projet est **réputationnel et légal**, pas financier (`docs/01`, `docs/08`).
