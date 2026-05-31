# Compliance Agent (RGPD / ePrivacy / CAN-SPAM) — DROIT DE VETO

## Mission
Gardien légal du système. Vérifie que chaque collecte, site et e-mail respecte le RGPD + ePrivacy (UE) et CAN-SPAM (US), et applique le plus strict des deux. Il possède un **droit de veto** : il peut poser le statut `blocked` sur tout artefact non conforme, et le `coordinator` ne publie/n'envoie jamais sans son OK. Gère la suppression list irréversible.

## Déclencheur / cadence
Tâche `tasks.agent='compliance'` créée par le `coordinator` avant toute sortie (publication d'un site, mise en file d'un e-mail), et sur événement (demande de retrait, opt-out).

## Entrées (lues en base / fichiers)
- `businesses` : `email, email_is_generic, data_source, source_url, consent_basis, retention_until`.
- `emails` : `to_email, unsubscribe_token, sender_identity, body_text`. `websites` : `noindex, status`.
- `suppression_list`, `audit_log`.

## Sorties (écrites en base / fichiers)
- Pose `emails.status='blocked'` / `websites.status` bloqué / `businesses.status='rejected'` avec raison.
- INSERT `suppression_list` (opt-out/retrait, irréversible) ; déclenche purge/effacement (droit à l'oubli < 72 h).
- `audit_log` actions `blocked`/`suppressed`/`erased` (source de vérité légale).

## Modèle LLM utilisé
Aucun pour les contrôles (règles déterministes). Ollama optionnel pour expliquer un blocage en clair. Jamais de décision légale déléguée à un LLM.

## Garde-fous (CRITIQUE)
- **Veto exécutoire** : tout e-mail sans unsubscribe + adresse postale + identité expéditeur = `blocked`. Tout site sans `noindex`/bandeau/retrait = `blocked`.
- **E-mails génériques pro EXCLUSIVEMENT** ; adresse nominative → bloquée.
- **Recheck suppression_list** systématique ; opt-out **irréversible**, jamais de réinscription.
- **Base légale documentée** (`consent_basis`, provenance) ; minimisation ; rétention bornée (purge `retention_until`).
- Au MVP : impose dry-run + pas de publication indexable. Doute juridique sérieux → blocage + `QUESTIONS_POUR_JEFF.md`.

## Critère de réussite
Aucune sortie non conforme ne franchit l'étape ; chaque opt-out/retrait est honoré et tracé dans `audit_log` ; le registre de traitement (provenance + base légale) est complet et auditable. En cas de doute, bloque par défaut.
