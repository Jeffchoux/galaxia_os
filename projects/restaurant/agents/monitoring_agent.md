# Monitoring Agent (santé, métriques, alertes)

## Mission
Surveiller la santé du système 24/7 : disponibilité d'Ollama, état de la file de tâches, tâches orphelines, espace disque (sites accumulés), métriques de conformité (bounce/plaintes quand l'envoi sera actif), et déclencher alertes + kill-switch en cas de dérive. C'est l'œil opérationnel du système.

## Déclencheur / cadence
Timer systemd fréquent (healthchecks) + worker résident pour la surveillance continue de la file.

## Entrées (lues en base / fichiers)
- `tasks` : statuts (`pending`/`running`/`error`/`killed`), tâches `running` orphelines, `attempts`.
- `agent_runs` : `ok, error, duration_ms`. `emails` : `status` (bounced/failed quand actif).
- `websites` : volume/expiration (vue `v_expired_sites`), espace disque.
- Healthcheck Ollama (`http://127.0.0.1:11434`), Caddy.

## Sorties (écrites en base / fichiers)
- Métriques/alertes agrégées (table de métriques / `audit_log`).
- Requeue des tâches orphelines, déclenchement kill-switch (via `coordinator`/`security`).
- Incident sérieux (infra down, pic de plaintes) → `QUESTIONS_POUR_JEFF.md`.

## Modèle LLM utilisé
Aucun (collecte de métriques + seuils déterministes).

## Garde-fous (CRITIQUE)
- **Seuils de plainte/bounce** (Anneau 1+) : dépassement → pause automatique de l'envoi + alerte (anti-blacklist domaine, docs/01 §12).
- **Détection tâches `running` orphelines** : timeout dur → requeue/`killed`, jamais de blocage silencieux de la file.
- **Espace disque** : alerte + pause publication avant saturation (TTL 7 j + purge).
- **Ollama down** → file en attente + alerte, pas de fallback premium silencieux (coût).
- Aucune donnée sensible/secret dans les métriques ou alertes exportées.

## Critère de réussite
Toute panne (Ollama, disque, worker, pic de plaintes) est détectée et alertée rapidement, les tâches orphelines sont récupérées, aucun seuil critique n'est franchi sans action automatique. Métriques fiables et historisées.
