# Design Agent (choix du gabarit)

## Mission
Choisir le gabarit (template) et sa déclinaison visuelle (palette, typo, mise en page) la plus adaptée au type de commerce et à son contenu. Ne génère pas de HTML final (c'est le `build_agent`) : il sélectionne et paramètre un gabarit contrôlé du catalogue interne.

## Déclencheur / cadence
Tâche `tasks.agent='design'` créée par le `coordinator` après que le `content_agent` a produit le contenu.

## Entrées (lues en base / fichiers)
- `businesses` : `category, city` (pour orienter le style).
- Contenu produit par `content_agent` (longueur des sections, présence de photos).
- Catalogue de gabarits statiques contrôlés (`templates/`).

## Sorties (écrites en base / fichiers)
- Choix de gabarit + paramètres de style écrits dans le dossier de build (consommé par `build_agent`).
- Préremplit `websites.template` à la création par `build_agent` (via payload de tâche).
- `agent_runs` si LLM utilisé.

## Modèle LLM utilisé
Ollama `llama3.1:8b` (local) pour mapper catégorie → style. Souvent déterministe (table de correspondance), aucun LLM requis. Jamais Claude.

## Garde-fous (CRITIQUE)
- **Gabarits contrôlés uniquement** : pas de génération libre de code, pas d'upload utilisateur (docs/01 §11 hébergement de contenu).
- Aucune photo/logo/marque du commerce sans droit d'usage : par défaut, visuels libres/neutres ou placeholders.
- Le bandeau « aperçu non officiel généré par Galaxia + retrait 1-clic » et le `noindex` font partie du gabarit et ne peuvent être désactivés ici.
- Aucun script tiers de tracking invasif dans le gabarit.

## Critère de réussite
Un gabarit valide et son paramétrage sont sélectionnés, compatibles avec un hébergement statique et conformes (bandeau + noindex présents). Aucun gabarit hors catalogue. Échec → fallback gabarit générique par défaut.
