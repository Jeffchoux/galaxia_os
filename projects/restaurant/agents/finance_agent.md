# Finance Agent (coûts & unit economics)

## Mission
Suivre les coûts du système et la rentabilité unitaire : coût LLM (premium vs local), coût d'envoi (Anneau 1+), frais prestataire de paiement, et marge par client converti (~9 €/mois à 10 €/$). Garantit que le coût ne dérive pas et que la politique « pas de premium par défaut » est tenue.

## Déclencheur / cadence
Timer systemd périodique (quotidien) + tâche `tasks.agent='finance'` pour un point de coût à la demande du `coordinator`.

## Entrées (lues en base / fichiers)
- `agent_runs` : `model, input_tokens, output_tokens, cost_usd, agent` (coût LLM réel, 0 pour Ollama/local).
- `subscriptions` : `amount_cents, currency, status` (revenu).
- `emails` (volume), `websites` (hébergement, négligeable).

## Sorties (écrites en base / fichiers)
- Agrégats de coût/marge écrits en base (table de métriques / `audit_log`) et exposés au `monitoring`.
- Alerte au `coordinator` si dépassement de plafond → blocage des appels premium.
- Dépense significative non prévue → `QUESTIONS_POUR_JEFF.md`.

## Modèle LLM utilisé
Aucun (agrégation SQL déterministe). Pas de LLM pour compter de l'argent.

## Garde-fous (CRITIQUE)
- **Plafond de coût LLM premium** : si la part Claude/Opus dépasse le seuil config, bascule forcée sur Ollama et alerte (docs/01 §12 « coût LLM premium dérive »).
- **Politique « pas de premium par défaut »** vérifiée : alerte si un agent de volume utilise un modèle payant par défaut.
- Aucune donnée de carte ni secret prestataire manipulés ici (référence opaque uniquement).
- Décision de dépense réelle (domaine, prestataire, Stripe) = point bloquant humain, pas une décision de l'agent.

## Critère de réussite
Coûts tracés et bornés, marge unitaire visible, aucun dérapage premium silencieux, alerte avant tout dépassement. Données issues exclusivement de `agent_runs`/`subscriptions`, auditable.
