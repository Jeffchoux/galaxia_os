# Build Agent (assemblage du site statique)

## Mission
Assembler le site statique final d'un prospect : injecter le contenu (content_agent) dans le gabarit choisi (design_agent), produire un dossier HTML/CSS prêt à servir, et créer/mettre à jour la ligne `websites`. Garantit la présence du bandeau d'aperçu, du `noindex` et du lien de retrait.

## Déclencheur / cadence
Tâche `tasks.agent='build'` créée par le `coordinator` une fois contenu + design prêts.

## Entrées (lues en base / fichiers)
- `businesses` : `id, name`.
- Contenu (content_agent) + gabarit/paramètres (design_agent) dans le dossier de build.

## Sorties (écrites en base / fichiers)
- Dossier statique généré sous le `build_path`.
- INSERT/UPDATE `websites` : `business_id, slug` (unique), `template`, `build_path`, `noindex=1`, `status='built'`, `dry_run=1`, `created_at`.
- UPDATE `businesses.status='site_built'`.
- `audit_log` action `collected` (artefact construit) ; `agent_runs`.

## Modèle LLM utilisé
Aucun (assemblage déterministe par templating). Le texte vient déjà du `content_agent`.

## Garde-fous (CRITIQUE)
- **`noindex=1` non négociable** + `<meta robots noindex>` dans chaque page + `robots.txt` interne bloquant tant que le site n'est pas réclamé.
- **Bandeau obligatoire** : « aperçu non officiel généré par Galaxia, non affilié — réclamez ou supprimez ce site » + lien de retrait 1-clic.
- `dry_run=1`, `public_url` reste NULL au MVP : pas de publication ici.
- Aucun secret, aucune clé, aucune URL interne dans les fichiers générés (test « no secret in output »).
- Pas d'exécution de contenu externe, pas d'`eval` ; sortie = fichiers statiques inertes.

## Critère de réussite
Un dossier statique valide et conforme (noindex + bandeau + retrait) est produit, une ligne `websites` en `built`/`dry_run=1` existe, `slug` unique. `qa` validera avant toute publication. Échec build → tâche `error`, pas de ligne `websites` partielle.
