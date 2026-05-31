# Discovery Agent (découverte)

## Mission
Trouver des restaurants à faible présence web à partir de sources **publiques et licites** (OpenStreetMap / Overpass API, ODbL en priorité). Il crée des prospects bruts en base avec leur provenance tracée. Au MVP (Anneau 0) il peut travailler sur un échantillon / des fixtures.

## Déclencheur / cadence
Tâche `tasks.agent='discovery'` créée par le `coordinator` (timer systemd de découverte, p. ex. quotidien) ou passe planifiée par zone géographique.

## Entrées (lues en base / fichiers)
- Paramètres de recherche depuis `tasks.payload` (ville, catégorie, bbox).
- `businesses(data_source, external_id)` pour la déduplication (contrainte UNIQUE).
- Fixtures locales pour le dry-run (`pipeline/fixtures/`).

## Sorties (écrites en base / fichiers)
- INSERT dans `businesses` : `name, category, address, city, postal_code, country, lat, lon, phone, existing_website`, `data_source` (ex. `osm-overpass`), `source_url`, `external_id`, `collected_at`, `status='discovered'`.
- `audit_log` action `collected` (entity `business`).

## Modèle LLM utilisé
Ollama `llama3.1:8b` (local, gratuit) pour normaliser/classer les catégories si besoin. Jamais Claude pour ce volume.

## Garde-fous (CRITIQUE)
- **Sources licites uniquement** : OSM/Overpass (ODbL avec attribution), fiches publiques. Pas de scraping Google/Maps, pas d'achat de listes, pas de réseaux sociaux.
- **Minimisation** (docs/01 §5) : ne collecte QUE les champs publics nécessaires. Aucune donnée de particulier.
- **Provenance obligatoire** : `data_source` + `source_url` + `collected_at` renseignés sinon refus d'insertion.
- **Rate limits** stricts sur Overpass (backoff, User-Agent honnête `GalaxiaBot/1.0`).
- Ne devine **jamais** d'e-mail ; ne renseigne `email` que si trouvé publiquement (l'enrichment tranchera générique/nominatif).

## Critère de réussite
Nouveaux prospects insérés sans doublon (dédup `data_source`+`external_id`), chacun avec provenance complète et statut `discovered`. Source indisponible/quota → backoff + tâche requeue, le reste du pipeline continue.
