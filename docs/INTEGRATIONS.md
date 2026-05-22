# Galaxia — intégrations & outils tiers à proposer aux PME

> Catalogue d'outils externes que Galaxia peut proposer à la PME selon le type
> de projet détecté. Galaxia ne s'enferme pas dans un seul fournisseur : elle
> agit comme un guide qui présente les options pertinentes au manager.
>
> Règle : chaque entrée doit préciser **quand** Galaxia la propose (déclencheur)
> et **pourquoi elle est compatible** avec la posture souveraine de Galaxia
> (open-source, on-premise, ou cloud-call uniquement si le manager accepte).

## Design & génération de sites

| Outil          | URL                  | Quand le proposer                                                | Modèle d'accès | Notes |
|----------------|----------------------|------------------------------------------------------------------|----------------|-------|
| motionsites.ai | https://motionsites.ai/ | Projet design / création de site vitrine PME : laisser le manager choisir un design parmi plusieurs propositions IA. | Cloud SaaS | Demande de Jeff (2026-05-22). À tester en pré-intégration : qualité des templates, conditions d'utilisation, possibilité d'export HTML/code, prix pour usage PME. Si export OK, Galaxia peut générer un brief, appeler le service, télécharger l'export, et le pousser sur le serveur de la PME. |

## Workflow & automatisation

_(à compléter au fil des découvertes)_

## LLM providers

Voir [`STACK.md`](STACK.md) — Claude / GPT / Gemini / Ollama sont les 4 fournisseurs LLM proposés par le wizard.

## Process d'ajout

1. Ouvrir un bloc dans [`../QUESTIONS_POUR_JEFF.md`](../QUESTIONS_POUR_JEFF.md) si la décision de l'intégrer engage un coût ou un partenariat.
2. Sinon (outil gratuit / OSS / API libre) : tester en sandbox, documenter ici, et planifier l'intégration dans le backlog `STATUS.md`.
3. Toute intégration doit pouvoir être **désactivée** par la PME (respect du mode "100% local").
