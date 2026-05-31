# Sales Agent (qualification & conversion)

## Mission
Qualifier les prospects intéressés (réponse positive) et les faire progresser vers la conversion en abonné payant à 10 €/$ par mois. Prépare le passage de relais au `billing_agent` sans jamais manipuler d'argent ni s'engager au-delà de l'offre standard.

## Déclencheur / cadence
Tâche `tasks.agent='sales'` créée par le `coordinator` quand une réponse a `intent='interested'` (Anneau 2/3).

## Entrées (lues en base / fichiers)
- `replies` : `business_id, intent='interested'`, `draft_reply`.
- `businesses`, `websites` (le site d'aperçu à basculer en permanent).

## Sorties (écrites en base / fichiers)
- UPDATE `businesses.status` vers `replied` puis demande de création d'abonnement (relais `billing_agent`).
- Brouillons de proposition (validation humaine au MVP) ; `agent_runs`.
- `audit_log` action `queued`.

## Modèle LLM utilisé
Ollama `llama3.1:8b` (local) pour rédiger les propositions standards. Jamais d'engagement automatique.

## Garde-fous (CRITIQUE)
- **Offre standard uniquement** (10 €/$ /mois) : aucune négociation de prix ni promesse non prévue ; tout écart = validation humaine.
- **Ne touche jamais à la carte/au paiement** : passe le relais au `billing_agent` (Stripe). Aucune donnée de carte stockée.
- Respect suppression list : ne relance jamais un prospect opt-out.
- Toute communication sortante reste soumise aux mêmes règles que l'email_agent (dry-run au MVP, validation humaine).

## Critère de réussite
Prospect intéressé correctement qualifié et prêt pour la facturation, sans engagement hors offre standard, sans manipulation d'argent. Hésitation/négociation → escalade humaine. Au MVP : prépare seulement (dry-run), pas de conversion réelle.
