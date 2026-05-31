"""Agent content — produit le contenu du site à partir des FAITS COLLECTÉS.

Règle dure (docs/01 §3.4) : ne JAMAIS inventer de fait (horaires, menu, prix,
allégations « meilleur de la ville »). On n'utilise que les champs vérifiables
récupérés ; tout le reste est un gabarit neutre, explicitement « à compléter ».

DRY-RUN : génération déterministe par gabarit (aucun appel réseau).
Option (désactivée par défaut) : enrichissement stylistique via Ollama local —
le texte reste cantonné aux faits, l'IA ne fait que reformuler du neutre.
"""
from __future__ import annotations

import re

PLACEHOLDER = "[à compléter par le restaurateur]"


def slugify(name: str, city: str | None = None) -> str:
    base = f"{name}-{city}" if city else name
    base = base.lower()
    base = re.sub(r"[àâä]", "a", base)
    base = re.sub(r"[éèêë]", "e", base)
    base = re.sub(r"[îï]", "i", base)
    base = re.sub(r"[ôö]", "o", base)
    base = re.sub(r"[ûü]", "u", base)
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    return base[:60] or "restaurant"


def build_content(business: dict, cfg: dict) -> dict:
    """Retourne un dict de blocs de contenu, chaque bloc marqué is_factual.

    is_factual=True  => provient d'une donnée collectée vérifiable (affichable tel quel)
    is_factual=False => gabarit neutre / placeholder (jamais présenté comme un fait)
    """
    name = business["name"]
    city = business.get("city") or ""
    cuisine = business.get("cuisine") or business.get("category") or "restaurant"

    facts = {
        "name": {"value": name, "is_factual": True},
        "address": {"value": business.get("address") or PLACEHOLDER,
                    "is_factual": bool(business.get("address"))},
        "city": {"value": city, "is_factual": bool(city)},
        "phone": {"value": business.get("phone") or PLACEHOLDER,
                  "is_factual": bool(business.get("phone"))},
        "cuisine": {"value": cuisine, "is_factual": bool(business.get("category"))},
    }

    # Texte NEUTRE — ne contient aucune allégation factuelle invérifiable.
    hero_tagline = f"{name}" + (f" — {city}" if city else "")
    about = (
        f"{name} vous accueille" + (f" à {city}" if city else "") + ". "
        "Cette page est un aperçu de site web généré automatiquement à partir "
        "d'informations publiques. Le restaurateur peut la personnaliser, corriger "
        "et compléter (menu, horaires, photos) en quelques minutes."
    )

    sections = [
        {"title": "Notre cuisine", "is_factual": False,
         "body": f"Spécialités : {cuisine}. {PLACEHOLDER} : présentez ici vos plats phares."},
        {"title": "Horaires", "is_factual": False,
         "body": f"{PLACEHOLDER} : indiquez vos jours et heures d'ouverture."},
        {"title": "Réserver / Nous trouver", "is_factual": bool(business.get("address")),
         "body": (f"Adresse : {facts['address']['value']}. "
                  f"Téléphone : {facts['phone']['value']}.")},
    ]

    return {
        "slug": slugify(name, city),
        "meta_description": f"{name}{' à ' + city if city else ''} — site web (aperçu Galaxia).",
        "hero_tagline": hero_tagline,
        "about": about,
        "facts": facts,
        "sections": sections,
        "cta": "Ce site vous plaît ? Réclamez-le et gardez-le en ligne pour 10 €/mois.",
    }
