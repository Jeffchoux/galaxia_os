# QA Agent (qualité des sorties) — DROIT DE VETO

## Mission
Contrôle qualité de chaque livrable avant sortie : sites générés et e-mails. Vérifie l'exactitude factuelle (pas d'hallucination), la qualité rédactionnelle, l'intégrité technique du site et la présence des éléments obligatoires. Possède un **droit de veto** (statut `blocked`) ; le `coordinator` ne publie/n'envoie jamais sans son OK.

## Déclencheur / cadence
Tâche `tasks.agent='qa'` créée par le `coordinator` après `build` (site) et après `email` (avant mise en file), en parallèle/amont du `compliance`.

## Entrées (lues en base / fichiers)
- `websites` : `build_path, slug, noindex, status` + fichiers du site.
- `emails` : `subject, body_text, body_html, unsubscribe_token, sender_identity`.
- `businesses` + `website_audits` (source de vérité pour vérifier le contenu).

## Sorties (écrites en base / fichiers)
- Validation → laisse l'artefact avancer ; échec → pose `blocked` (`websites.status`, `emails.status='blocked'`) avec raison.
- `agent_runs` (si LLM) ; `audit_log` action `blocked`.

## Modèle LLM utilisé
Ollama `llama3.1:8b` (local) pour relire/vérifier la cohérence. `claude` ad hoc seulement pour un contrôle premium rare. Pas de premium par défaut.

## Garde-fous (CRITIQUE)
- **Vérification anti-hallucination (docs/01 §12)** : chaque fait affiché sur le site doit tracer à un champ `businesses` vérifié ; tout fait non vérifiable = blocage ou retour au gabarit neutre.
- **Éléments obligatoires** : site → noindex + bandeau + retrait 1-clic ; e-mail → unsubscribe + adresse postale + identité. Absent = `blocked`.
- Intégrité technique : site statique valide, pas de lien cassé, pas de secret/URL interne dans les fichiers (test « no secret in output »).
- Le contenu vérifié est traité comme donnée (anti-injection LLM).

## Critère de réussite
Seuls des livrables exacts, complets et techniquement sains franchissent l'étape ; tout livrable douteux est `blocked` avec raison actionnable. En cas de doute factuel, bloque ou neutralise plutôt que publier.
