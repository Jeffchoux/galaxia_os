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

# Allégations invérifiables qu'un LLM pourrait halluciner dans un texte de présentation.
# Si l'enrichissement en introduit une absente de l'original, on rejette (docs/01 §3.4).
_UNVERIFIABLE = (
    "meilleur", "élu", "elue", "primé", "prime", "étoil", "etoil", "michelin",
    "gault", "millau", "incontournable", "réputé", "repute", "renommé", "renomme",
    "depuis 19", "depuis 20", "n°1", "numéro 1", "numero 1", "authentique",
)

_ENRICH_SYSTEM = (
    "Tu reformules un court paragraphe de présentation pour le site web d'un restaurant. "
    "Écris en français, ton chaleureux et professionnel. RÈGLES ABSOLUES : n'invente AUCUN "
    "fait — pas d'horaires, de prix, de plats, de spécialités, de distinctions, d'années, "
    "ni d'aucun chiffre. Pas de superlatif (meilleur, réputé, authentique…). Conserve "
    "strictement le sens du texte fourni. Réponds UNIQUEMENT par le paragraphe reformulé, "
    "sans préambule ni guillemets."
)


def _validate_enrichment(original: str, candidate: str) -> tuple[bool, str]:
    """Garde-fou « aucun fait inventé » sur le texte reformulé par le LLM.

    Rejette si le candidat est vide, trop court/long, introduit un chiffre absent de
    l'original (horaire/prix/année hallucinés) ou une allégation invérifiable.
    """
    cand = candidate.strip()
    if not cand:
        return False, "réponse vide"
    if len(cand) < max(30, int(len(original) * 0.4)):
        return False, "trop court"
    if len(cand) > int(len(original) * 2.2) + 200:
        return False, "trop long"
    orig_nums = set(re.findall(r"\d+", original))
    if any(num not in orig_nums for num in re.findall(r"\d+", cand)):
        return False, "chiffre inventé"
    low = cand.lower()
    if any(token in low for token in _UNVERIFIABLE if token not in original.lower()):
        return False, "allégation invérifiable"
    return True, "ok"


def _maybe_enrich(about: str, cfg: dict) -> tuple[str, dict]:
    """Reformulation stylistique du paragraphe NEUTRE via Ollama local (opt-in).

    Désactivé par défaut (`llm.content_enrichment: false`). Ne touche que le texte
    neutre `about` (aucune allégation factuelle) ; les faits collectés ne passent
    jamais par le LLM. Tout échec/refus retombe sur le texte déterministe.
    """
    meta = {"used": False, "model": "deterministic", "provider": "none",
            "cost_usd": 0.0, "duration_ms": 0, "reason": "disabled"}
    if not (cfg.get("llm", {}) or {}).get("content_enrichment", False):
        return about, meta

    from . import llm as _llm  # import paresseux : zéro coût quand désactivé
    res = _llm.generate(f"Paragraphe à reformuler :\n\n{about}", cfg,
                        system=_ENRICH_SYSTEM, timeout=30.0)
    meta.update(model=res["model"], provider=res["provider"],
                duration_ms=res["duration_ms"], cost_usd=res["cost_usd"])
    candidate = res.get("text", "")
    valid, why = _validate_enrichment(about, candidate)
    if res["ok"] and valid:
        meta["used"], meta["reason"] = True, "ok"
        return candidate.strip(), meta
    meta["reason"] = res["error"] or why
    return about, meta


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
    # Reformulation stylistique optionnelle (Ollama local, opt-in) — sur le neutre seul.
    about, enrichment = _maybe_enrich(about, cfg)

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
        "enrichment": enrichment,
    }
