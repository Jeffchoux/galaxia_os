# Billing Agent (abonnement & facturation)

## Mission
Gérer la conversion payante (Anneau 3) : créer et suivre l'abonnement 10 €/$ par mois via un prestataire conforme (Stripe). Galaxia ne stocke ni ne manipule JAMAIS de numéro de carte : tout le paiement, la facturation, la TVA et la rétractation sont délégués au prestataire. Inactif au MVP (dry-run).

## Implémentation (code prêt, mode test — 2026-05-31)
La logique est codée dans **`pipeline/billing.py`** (Checkout + webhooks + transitions d'état) et **`pipeline/billing_webhook.py`** (récepteur HTTP signé), testée dans `tests/test_billing.py` (hermétique, faux Stripe). **Garde Anneau 3** : inerte tant que `ring < 3` ET `billing.enabled=false`. Détail : `docs/04 §5.1`. Cet agent `.md` reste la spec ; le code en est l'exécution déterministe (pas de LLM dans la boucle de paiement).

## Déclencheur / cadence
Tâche `tasks.agent='billing'` créée par le `coordinator` après qualification par `sales_agent` (Anneau 3 uniquement) + webhooks prestataire pour les changements d'état.

## Entrées (lues en base / fichiers)
- `businesses`, `websites` (site à basculer en permanent à l'activation).
- Événements prestataire (références opaques, jamais de PAN).

## Sorties (écrites en base / fichiers)
- INSERT/UPDATE `subscriptions` : `business_id, website_id, provider='stripe', provider_customer_id, provider_sub_id, currency, amount_cents=1000, status` (pending/active/past_due/canceled), `started_at`, `canceled_at`.
- À l'activation : `websites.status='claimed'`, `noindex` levé (site réclamé), `businesses.status='converted'`.
- `audit_log` actions `queued`/`published`.

## Modèle LLM utilisé
Aucun (logique financière déterministe + API prestataire). Pas de LLM dans une boucle de paiement.

## Garde-fous (CRITIQUE)
- **Aucun débit automatique sans prestataire conforme** (docs/01 §3.6) : pas de bricolage de paiement. **Galaxia ne stocke jamais de carte** (hors-PCI).
- **Anneau 3 requis** : tant que non activé par décision business → ne fait rien (point bloquant `QUESTIONS_POUR_JEFF.md` : compte Stripe, CGV, mentions légales, droit de rétractation).
- Références prestataire opaques uniquement en base ; aucun secret prestataire en clair/loggé.
- Idempotence sur les webhooks (pas de double facturation).

## Critère de réussite
Abonnement créé et suivi correctement via le prestataire, site basculé en permanent à l'activation, aucune donnée de carte chez Galaxia. Au MVP : agent inactif, aucune transaction. Échec paiement → `status='past_due'`, alerte, pas de double débit.
