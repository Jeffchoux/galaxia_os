# 08 — Exploitation quotidienne (run 24/7)

> Projet **`restaurant`** — faire tourner le système **24/7** : timers, inspection d'état,
> kill-switches, seuils d'alerte, sauvegarde, runbook d'incidents, supervision humaine.
> Source de vérité : `docs/00` (§8 timers, §9 worker), `docs/01` (§12 pannes),
> `database/schema.sql`. Tous les chemins/commandes sont concrets.

Conventions : base = `projects/restaurant/data/restaurant.db` (SQLite WAL). Pas de CLI
`sqlite3` sur l'hôte → on passe par le **module Python** (`python3 -c …` ou
`pipeline/db.py`). Services systemd côté `galaxia` ; build/check possible côté `root`
(cf. mémoire build cockpit). Timestamps en **ms epoch**.

---

## 1. Boucles planifiées (timers systemd + worker résident)

Aligné sur le pattern existant (`galaxia-*.timer` / `galaxia-tg-worker.service`).

| Unité (`ops/`) | Cadence | Rôle | Agent |
|----------------|---------|------|-------|
| `restaurant-discovery.timer` | quotidien (matin) | découvrir de nouveaux prospects (OSM) | discovery |
| `restaurant-pipeline.timer` | toutes les 15–30 min | faire avancer audit→content→build | website_audit/content/design/build |
| `restaurant-hosting-purge.timer` | horaire | retirer les sites expirés (`v_expired_sites`, TTL 7 j) | hosting |
| `restaurant-followups.timer` | quotidien | enfiler relances bornées (Anneau 2, dry-run) | email/reply |
| `restaurant-monitoring.timer` | toutes les 5 min | healthchecks, métriques, alertes | monitoring |
| `restaurant-finance.timer` | quotidien | agréger coûts `agent_runs`, vérifier plafond | finance |
| `restaurant-backup.timer` | quotidien (nuit) | sauvegarde de `restaurant.db` | ops |
| `restaurant-worker.service` | **résident** (`Restart=on-failure`) | claim atomique des `tasks`, exécution (Ollama/claude), timeout dur, kill-switch | worker |

Inspection des timers :

```bash
systemctl --user list-timers 'restaurant-*'      # ou sans --user selon l'install
systemctl status restaurant-worker.service
journalctl -u restaurant-worker.service -n 200 --no-pager
```

---

## 2. Inspecter l'état du système

### Healthcheck rapide

```bash
bash projects/restaurant/ops/healthcheck.sh
```

`healthcheck.sh` vérifie : Ollama répond (`curl -fsS http://127.0.0.1:11434/api/tags`),
worker actif, base accessible + intègre, espace disque, dossier sites sous quota, et
absence de tâches `running` orphelines. Sortie non nulle = au moins un check KO (utilisable
par monitoring/alerte).

### Requêtes d'état (via module Python)

Helper : `python3 projects/restaurant/pipeline/db.py --sql "<REQUÊTE>"` (ou un `python3 -c`
qui ouvre `sqlite3.connect(...)`). Exemples :

```sql
-- Répartition des prospects par statut
SELECT status, COUNT(*) FROM businesses GROUP BY status ORDER BY 2 DESC;

-- File de tâches : santé
SELECT status, COUNT(*) FROM tasks GROUP BY status;

-- Tâches running depuis > 10 min (orphelines potentielles)
SELECT id, agent, attempts, updated_at FROM tasks
WHERE status='running'
  AND updated_at < (CAST(strftime('%s','now') AS INTEGER) - 600) * 1000;

-- Prospects réellement contactables (vue garde-fou)
SELECT COUNT(*) FROM v_contactable;

-- Sites expirés en attente de purge
SELECT COUNT(*) FROM v_expired_sites;

-- E-mails par statut (doit rester majoritairement dry_run au MVP)
SELECT status, dry_run, COUNT(*) FROM emails GROUP BY status, dry_run;

-- Dernières actions sensibles (audit RGPD)
SELECT created_at, entity, action, actor FROM audit_log
ORDER BY created_at DESC LIMIT 20;
```

---

## 3. Kill-switches

| Niveau | Levier | Comment |
|--------|--------|---------|
| **Global envoi** | drapeau config `send_enabled=false` (et `dry_run=true`) | par défaut **off** ; tant qu'off, aucun e-mail ne quitte `drafted/dry_run`. Réactiver = décision Jeff. |
| **Global pipeline** | stopper le worker | `systemctl stop restaurant-worker.service` (les timers continuent d'enfiler, rien ne s'exécute) |
| **Par agent** | pause ciblée | drapeau config `agents.<nom>.paused=true` → le worker saute les tâches de cet agent (les laisse `pending`) |
| **Tâche en cours** | kill par `pgid` | `tasks.pgid` stocke le groupe process → `kill -TERM -<pgid>` (pattern worker telegram) ; tâche → `killed` |
| **Premium LLM** | plafond `premium_daily_cap_usd` | dépassement → finance alerte + coordinator force Ollama |
| **Retrait d'un site** | hosting `removed` | passe `websites.status='removed'`, supprime le dossier, `audit_log` |

> Position par défaut **sûre** : `dry_run=true`, `send_enabled=false`. Le système peut tourner
> indéfiniment sans aucun effet externe (`docs/01` Anneau 0).

---

## 4. Seuils d'alerte (monitoring)

| Métrique | Seuil d'alerte | Action automatique |
|----------|----------------|--------------------|
| **Taux de bounce** (envoi réel, Anneau 1+) | > 3 % | pause envoi + alerte |
| **Taux de plainte spam** | > 0,1 % | **kill-switch envoi** + alerte (réputation) |
| **Ollama down** | `curl` échoue 2× de suite | tâches LLM en attente, alerte, retry/backoff |
| **Disque** | > 80 % utilisé | alerte ; > 90 % → purge agressive des sites expirés |
| **Sites publiés** | au-delà du quota config | alerte + bloque nouvelles publications |
| **Tâches `error`** | > N sur 1 h | alerte (boucle d'échec) |
| **Tâches `running` orphelines** | âge > timeout dur | requeue + alerte |
| **Coût premium/jour** | > `premium_daily_cap_usd` | gel du premium + alerte finance |
| **Worker inactif** | service down | `Restart=on-failure` + alerte si répété |

Canal d'alerte : journald + (réutilisable) le bot Telegram Galaxia / digest. Toute alerte
sérieuse légale/sécurité/financière → entrée dans `QUESTIONS_POUR_JEFF.md`.

---

## 5. Sauvegarde de `restaurant.db`

SQLite **WAL** : ne pas copier le fichier à chaud sans `.backup`. Utiliser l'API de sauvegarde
en ligne (cohérente, ne lock pas) via Python :

```bash
python3 - <<'PY'
import sqlite3, time, os
src = "projects/restaurant/data/restaurant.db"
dst = f"projects/restaurant/backups/restaurant-{time.strftime('%Y%m%d-%H%M%S')}.db"
os.makedirs(os.path.dirname(dst), exist_ok=True)
s = sqlite3.connect(src); d = sqlite3.connect(dst)
with d:
    s.backup(d)                # snapshot cohérent (gère WAL)
s.close(); d.close()
print("backup ->", dst)
PY
```

Politique : `restaurant-backup.timer` quotidien (nuit), **rétention 14 jours** (rotation des
fichiers `backups/restaurant-*.db`), vérification d'intégrité du dernier backup
(`PRAGMA integrity_check`). Les backups ne contiennent **aucun secret** (clés en
`/opt/galaxia/config/.env`, jamais en base).

---

## 6. Runbook — incidents courants

### Ollama down (génération bloquée)
1. `curl -fsS http://127.0.0.1:11434/api/tags` → confirme la panne.
2. `systemctl status ollama` ; `journalctl -u ollama -n 100`.
3. `systemctl restart ollama` ; vérifier que `llama3.1:8b` est chargé (`ollama list`).
4. Les tâches LLM sont restées `pending` (rien perdu) → reprennent seules.
5. Si VRAM/RAM saturée : réduire la concurrence du worker, vérifier les autres daemons.

### Disque plein (sites accumulés)
1. `df -h` ; `du -sh /var/www/galaxia-restaurant-sites/*`.
2. Forcer la purge : exécuter l'agent hosting sur `v_expired_sites` (ou
   `restaurant-hosting-purge.timer` en manuel).
3. Vérifier rotation des backups et des `logs/dry_run_emails/`.
4. Si toujours plein : abaisser le quota de sites publiés, alerter.

### Demande de retrait (takedown) — à traiter **< 72 h**
1. Identifier le `business` (par e-mail/nom/slug).
2. `compliance` ajoute l'e-mail à **`suppression_list`** (`reason='takedown'`).
3. `hosting` passe le site `removed` et **supprime le dossier**.
4. `business.status='suppressed'` ; effacer les données personnelles (`audit_log
   action='erased'`).
5. Confirmer au demandeur. Délai cible **< 72 h** (`docs/01` §5).

### Pic de plaintes spam (réputation)
1. Monitoring déclenche le **kill-switch envoi** (`send_enabled=false`).
2. Geler les relances ; analyser les plaintes (segment, contenu, source).
3. Ajouter les plaignants en `suppression_list` (`reason='complaint'`).
4. Ne **pas** relancer l'envoi sans décision Jeff (`QUESTIONS_POUR_JEFF.md`) + correctifs.

### Worker planté / tâche orpheline
1. `systemctl status restaurant-worker.service` (devrait `Restart=on-failure`).
2. Requeue des `running` orphelines (timeout dur dépassé) → `pending`, `attempts++`.
3. Si une tâche échoue en boucle (`attempts` élevé) → la mettre `error`, inspecter `result`.

### Base lock / corruption
1. WAL + `BEGIN IMMEDIATE` limitent les locks ; vérifier qu'aucun process ne tient une
   transaction longue.
2. `PRAGMA integrity_check` ; si KO → restaurer le dernier backup (§5).

---

## 7. Checklist de supervision humaine

**Quotidien (5 min)**
- [ ] `healthcheck.sh` vert (Ollama, worker, disque, base).
- [ ] `tasks` : pas d'accumulation d'`error` ni d'`running` orphelines.
- [ ] `businesses` par statut : progression cohérente, pas de blocage massif.
- [ ] `emails` : restent en `dry_run` (tant que `send_enabled=false`).
- [ ] `QUESTIONS_POUR_JEFF.md` : aucune escalade non traitée.

**Hebdomadaire**
- [ ] Coûts `agent_runs` (`docs/07` requête) sous plafond ; premium ≈ 0.
- [ ] `v_expired_sites` vidée régulièrement (purge OK).
- [ ] Échantillon de sites/e-mails relu (qualité, faits, unsubscribe, noindex).
- [ ] Backups présents, rotation OK, `integrity_check` du dernier backup vert.
- [ ] `suppression_list` respectée (aucun contact d'une adresse supprimée).

**Avant tout passage d'anneau (envoi/paiement réel)**
- [ ] Points bloquants de `docs/01` §13 tranchés (domaine+SPF/DKIM/DMARC, base légale, Stripe,
      adresse postale) — sinon **rester en dry-run**.

> Règle d'or : en cas de doute légal/sécurité/financier/infra → **bloquer**, consigner dans
> `QUESTIONS_POUR_JEFF.md`, garder le système en position par défaut sûre (dry-run, envoi off).
