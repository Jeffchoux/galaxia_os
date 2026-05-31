"""Chargement de la configuration YAML.

Sans dépendance obligatoire : utilise PyYAML s'il est présent, sinon un
mini-parseur du sous-ensemble YAML réellement employé par config/default.yaml
(maps imbriquées indentées de 2 espaces, listes `- x`, scalaires, commentaires
`#`, chaînes entre guillemets). Volontairement simple ; pour des structures plus
riches, installer PyYAML.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent  # projects/restaurant/


def _coerce(val: str) -> Any:
    v = val.strip()
    if not v:
        return None
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    # liste « flow » inline : [a, b, c]
    if len(v) >= 2 and v[0] == "[" and v[-1] == "]":
        inner = v[1:-1].strip()
        return [_coerce(p) for p in inner.split(",")] if inner else []
    low = v.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if low in ("null", "~"):
        return None
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        pass
    return v


def _strip_comment(line: str) -> str:
    """Retire un commentaire `#` situé hors guillemets."""
    out, quote = [], None
    for ch in line:
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            out.append(ch)
        elif ch == "#":
            break
        else:
            out.append(ch)
    return "".join(out).rstrip()


def _parse_block(lines: list[tuple[int, str]], idx: int, indent: int) -> tuple[Any, int]:
    """Parse récursivement un bloc à l'indentation >= `indent`.

    Retourne (valeur, prochain_index). La valeur est un dict ou une liste selon
    que les lignes commencent par `- ` (liste) ou `clé:` (map).
    """
    # Détermine le type du bloc d'après la première ligne significative.
    first_ind, first_txt = lines[idx]
    is_list = first_txt.startswith("- ")
    container: Any = [] if is_list else {}

    while idx < len(lines):
        ind, txt = lines[idx]
        if ind < indent:
            break
        if ind > indent:
            # ne devrait pas arriver : géré par récursion sur les clés
            raise ValueError(f"indentation inattendue: {txt!r}")

        if txt.startswith("- "):
            item_txt = txt[2:].strip()
            if ":" in item_txt and not (item_txt[0] in "\"'"):
                # item de liste qui est une map inline « - clé: val » (non utilisé ici)
                k, _, r = item_txt.partition(":")
                container.append({k.strip(): _coerce(r)})
            else:
                container.append(_coerce(item_txt))
            idx += 1
            continue

        if ":" not in txt:
            raise ValueError(f"ligne YAML non gérée: {txt!r}")
        key, _, rest = txt.partition(":")
        key, rest = key.strip(), rest.strip()
        if rest == "":
            # bloc enfant : on regarde l'indentation de la ligne suivante
            if idx + 1 < len(lines) and lines[idx + 1][0] > indent:
                child, idx = _parse_block(lines, idx + 1, lines[idx + 1][0])
                container[key] = child
            else:
                container[key] = None
                idx += 1
        else:
            container[key] = _coerce(rest)
            idx += 1
    return container, idx


def _mini_yaml(text: str) -> dict:
    lines: list[tuple[int, str]] = []
    for raw in text.splitlines():
        stripped = _strip_comment(raw)
        if not stripped.strip():
            continue
        ind = len(stripped) - len(stripped.lstrip(" "))
        lines.append((ind, stripped.strip()))
    if not lines:
        return {}
    data, _ = _parse_block(lines, 0, lines[0][0])
    return data if isinstance(data, dict) else {"_root": data}


def _load_one(cfg_path: Path) -> dict:
    text = cfg_path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
        loaded = yaml.safe_load(text)
        if isinstance(loaded, dict):
            return loaded
    except ImportError:
        pass
    return _mini_yaml(text)


def _deep_merge(base: dict, over: dict) -> dict:
    """Fusionne récursivement `over` dans `base` (les maps imbriquées sont fusionnées,
    les scalaires/listes écrasés)."""
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def load_config(path: str | Path | None = None) -> dict:
    cfg_path = Path(path) if path else PROJECT_ROOT / "config" / "default.yaml"
    cfg = _load_one(cfg_path)
    # Surcharge locale (gitignored) : fusionnée uniquement pour le chargement par défaut.
    # Sert p.ex. à activer le mode canari (dry_run:false + redirect_all_to) sans modifier
    # le défaut sûr committé.
    if path is None:
        local = PROJECT_ROOT / "config" / "local.yaml"
        if local.exists():
            _deep_merge(cfg, _load_one(local))
    return cfg


def resolve_path(cfg: dict, key: str) -> Path:
    """Résout un chemin de cfg['paths'] relativement à la racine projet."""
    raw = cfg["paths"][key]
    p = Path(raw)
    return p if p.is_absolute() else PROJECT_ROOT / p


if __name__ == "__main__":
    import json
    print(json.dumps(load_config(), indent=2, ensure_ascii=False))
