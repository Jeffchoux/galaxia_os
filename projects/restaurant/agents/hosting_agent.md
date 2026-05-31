# Hosting Agent (hébergement temporaire)

## Mission
Gérer le cycle de vie d'hébergement des sites générés : publication (Anneau 1+), TTL de 7 jours, expiration et purge, retrait immédiat sur demande. Au MVP (Anneau 0) il ne publie rien publiquement : les sites restent consultables en local uniquement.

## Déclencheur / cadence
Tâche `tasks.agent='hosting'` (coordinator) pour publier/retirer + timer systemd de purge périodique qui balaie la vue `v_expired_sites`.

## Entrées (lues en base / fichiers)
- `websites` : `id, slug, build_path, status, dry_run, noindex, expires_at`.
- Vue `v_expired_sites` (sites publiés expirés à purger).
- Demandes de retrait (via `compliance`/`reply` → suppression).

## Sorties (écrites en base / fichiers)
- Copie/lien du `build_path` vers `/var/www/galaxia-restaurant-sites/{slug}/` (Anneau 1+ uniquement) servi par Caddy `file_server`.
- UPDATE `websites` : `status` (published/expired/removed/claimed), `public_url`, `published_at`, `expires_at` (=published_at + 7 j), `removed_at`.
- `audit_log` actions `published` / `removed`.

## Modèle LLM utilisé
Aucun (opérations fichier/DB déterministes).

## Garde-fous (CRITIQUE)
- **Anneau 0 = aucune publication publique indexable** : ne publie que si l'anneau le permet ET `qa`/`compliance` n'ont pas `blocked`. Sinon reste `built`, `dry_run=1`.
- **`noindex` obligatoire** sur tout site servi tant que non réclamé ; refuse de publier un site sans bandeau/retrait.
- **TTL strict 7 j** : purge automatique à expiration (suppression du dossier + `status='expired'`).
- **Retrait < 72 h** sur demande (docs/01 §5) : suppression immédiate du dossier + `status='removed'`.
- Quota disque / monitoring espace ; pas de service de contenu uploadé par un tiers.

## Critère de réussite
Aucun site publié hors anneau autorisé ; tout site publié porte noindex + bandeau ; expiration et retraits exécutés dans les délais ; aucun dossier orphelin sur disque. Disque saturé → alerte monitoring + pause publication.
