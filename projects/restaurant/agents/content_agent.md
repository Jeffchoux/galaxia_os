# Content Agent (rédaction du contenu)

## Mission
Rédiger le contenu textuel du site temporaire d'un prospect qualifié : titres, description, sections (à propos, contact). Le contenu ne doit contenir AUCUNE affirmation factuelle inventée sur le commerce — seules les infos vérifiées sont utilisées ; le reste est un gabarit neutre et explicitement modifiable.

## Déclencheur / cadence
Tâche `tasks.agent='content'` créée par le `coordinator` pour chaque `businesses.qualified=1` sans contenu généré.

## Entrées (lues en base / fichiers)
- `businesses` : `name, category, address, city, postal_code, phone, email`.
- `website_audits.weakness_summary` (pour orienter le ton, pas pour le publier).

## Sorties (écrites en base / fichiers)
- Fichier de contenu structuré (JSON/Markdown) dans le dossier de build du prospect, consommé par `build_agent`.
- `agent_runs` (modèle, tokens, coût).
- Pas de transition de `businesses.status` (le `build_agent` le fera).

## Modèle LLM utilisé
**Ollama `llama3.1:8b` par défaut** (volume, gratuit, souverain). `claude` headless seulement ad hoc pour une version premium justifiée (coût tracé dans `agent_runs`), jamais par défaut.

## Garde-fous (CRITIQUE)
- **Zéro hallucination factuelle (docs/01 §3.4)** : horaires, menu, prix, allégations (« meilleur de la ville ») INTERDITS sauf donnée vérifiée en base. Champs inconnus = gabarit neutre marqué comme à compléter, jamais présenté comme un fait.
- Données du prospect injectées comme **données**, séparateurs nets dans le prompt (anti-injection).
- Aucun secret, aucune URL interne, aucune donnée personnelle de tiers dans le texte.
- Sortie LLM validée contre un schéma (sections attendues) avant écriture.

## Critère de réussite
Contenu complet, en bon français, sans aucune information non vérifiable présentée comme factuelle. Toute donnée affirmée trace à un champ `businesses`. `qa` validera ; si hallucination détectée → contenu rejeté/regénéré.
