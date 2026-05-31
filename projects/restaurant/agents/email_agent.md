# Email Agent (génération des e-mails d'outreach)

## Mission
Générer et mettre en file les e-mails de prospection et de relance pour les prospects contactables. Au MVP (Anneau 0) il fonctionne **strictement en dry-run** : chaque e-mail est écrit sur disque, aucun envoi réel. Chaque message porte obligatoirement un lien de désinscription fonctionnel et l'adresse postale de l'expéditeur.

## Déclencheur / cadence
Tâche `tasks.agent='email'` créée par le `coordinator` pour les prospects de la vue `v_contactable` au statut `site_built`, et relances dues (followup).

## Entrées (lues en base / fichiers)
- Vue `v_contactable` (qualifié + e-mail générique + **pas dans suppression_list**).
- `businesses` : `name, email, city`. `websites` : `id, slug` (lien vers l'aperçu).
- `emails` existants (pour cadencer followup_1 / followup_2).

## Sorties (écrites en base / fichiers)
- INSERT `emails` : `business_id, website_id, kind, to_email, subject, body_text, body_html, unsubscribe_token` (unique, non devinable), `sender_identity`, `status='dry_run'`, `dry_run=1`, `dry_run_path`.
- Fichier dans `logs/dry_run_emails/`.
- UPDATE `businesses.status='contacted'` ; `audit_log` action `queued`.

## Modèle LLM utilisé
**Ollama `llama3.1:8b` par défaut** (rédaction de masse, gratuit). `claude` ad hoc seulement si qualité premium justifiée, coût tracé.

## Garde-fous (CRITIQUE)
- **Recheck `suppression_list` AVANT chaque mise en file** (irréversible) — adresse supprimée → `status='blocked'`, `blocked_reason='suppressed'`, aucun e-mail.
- **Adresse générique uniquement** (`email_is_generic=1`) ; jamais d'adresse nominative.
- **Token de désinscription obligatoire + adresse postale + identité expéditeur** dans chaque e-mail : sans eux, `blocked_reason='no_unsubscribe'`, pas de mise en file.
- **`dry_run=1` au MVP** : aucun envoi réel, aucune connexion MTA. L'envoi réel est un point bloquant `QUESTIONS_POUR_JEFF.md`.
- Rate limits / cadence de relance bornée (max followup_1, followup_2 ; stop à réponse ou opt-out).

## Critère de réussite
E-mails générés conformes (unsubscribe + postale + identité), écrits sur disque, jamais envoyés, jamais à une adresse supprimée ou nominative. Un e-mail non conforme est `blocked`, jamais envoyé. `qa`/`compliance` peuvent bloquer.
