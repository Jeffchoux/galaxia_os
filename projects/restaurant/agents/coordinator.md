# Coordinator (chef d'orchestre)

## Mission
Orchestrateur central du système. Il ne fait aucun travail métier lui-même : il décide quoi faire, pour quel prospect, dans quel ordre, et dispatche le travail aux agents spécialisés via la table `tasks`. Il applique la stratégie par anneaux de risque, fait respecter les vetos `compliance` et `qa`, et tranche en autonomie sans jamais demander à l'humain — sauf risque légal/sécurité/financier/infra sérieux, qu'il consigne dans `QUESTIONS_POUR_JEFF.md`.

## Déclencheur / cadence
Worker résident systemd (gabarit `galaxia-tg-worker.service`) tournant 24/7 + timer systemd de réveil périodique (`ops/`) qui relance une passe de planification (découverte, relances dues, purge TTL).

## Entrées (lues en base / fichiers)
- `businesses.status` (toutes les valeurs du cycle : discovered → enriched → audited → qualified → site_built → contacted → replied → converted/lost).
- `websites.status`, `websites.expires_at` (sites à publier/purger), vue `v_expired_sites`.
- `emails.status`, `replies.handled`, `subscriptions.status`.
- `tasks` (état global de la file), `agent_runs` (coûts/santé).
- Drapeau global `dry_run` et niveau d'anneau actif (config + `schema_meta`).

## Sorties (écrites en base / fichiers)
- Crée des lignes dans `tasks` (id uuid, `agent`, `business_id`, `payload` JSON, `priority`) pour chaque étape à exécuter.
- Met à jour `businesses.status` lors des transitions validées.
- Écrit dans `audit_log` (action `queued`, `blocked`) chaque décision sensible.
- Ajoute des points bloquants dans `QUESTIONS_POUR_JEFF.md` (jamais de question triviale).

## Modèle LLM utilisé
Aucun en routine (logique déterministe de routage/priorisation). `claude` ad hoc seulement pour un arbitrage complexe rare ; jamais de premium par défaut.

## Garde-fous (CRITIQUE)
- **Anneau 0 (dry-run) imposé** : ne déclenche aucun envoi e-mail réel ni publication publique indexable. `emails.dry_run=1`, `websites.noindex=1`.
- **Veto absolu** : ne fait jamais transitionner un `business`/`website`/`email` vers une étape de sortie si `compliance` ou `qa` a posé le statut `blocked`. Pas de contournement.
- Vérifie via `v_contactable` (suppression list incluse) avant de mettre en file une tâche `email`.
- Claim atomique des tâches (`BEGIN IMMEDIATE`), timeout dur + requeue des tâches `running` orphelines, respect des rate limits par agent.
- Ne demande JAMAIS à l'humain pour un choix réversible ; bloque (et écrit `QUESTIONS_POUR_JEFF.md`) uniquement sur : envoi réel, domaine d'envoi/DNS, Stripe, dépense, faille sécurité.

## Critère de réussite
Chaque prospect avance dans le pipeline sans étape sautée, sans tâche orpheline, sans aucun envoi/publication non conforme, et toute décision est traçable dans `audit_log`. Échec d'un agent → tâche `error`, retry borné, puis escalade en `blocked` si répétée, sans bloquer le reste de la file.
