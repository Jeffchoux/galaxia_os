# Questions pour Jeff

> Ce fichier est le **seul canal** pour les questions business qui me bloquent.
> Je n'interromps pas Jeff dans le chat. Je travaille en autonomie complète sur tout
> le reste. Jeff répond ici quand il a un moment ; je dépile au fil de l'eau.
>
> **Format** : une question = un bloc. Bloc daté, court, avec impact business clair
> et options proposées. Quand Jeff répond, je déplace le bloc dans
> [`docs/DECISIONS.md`](docs/DECISIONS.md) (à créer) avec la réponse + la date.

---

## 1bis. GitHub — ajouter la deploy key au bon repo

**Posée le :** 2026-05-22
**Statut :** ouverte (Q1 partiellement résolue, voir [`docs/DECISIONS.md`](docs/DECISIONS.md))

URL repo confirmée : `https://github.com/Jeffchoux/galaxia_os`. J'ai mis à jour
le remote local en conséquence (`git@github.com:Jeffchoux/galaxia_os.git`).

**Push toujours bloqué** : la deploy key SSH n'est pas connue de ce repo.
Test SSH retourne `Permission denied (publickey)`.

**Action côté Jeff (2 min)** :

1. Aller sur https://github.com/Jeffchoux/galaxia_os/settings/keys
2. Cliquer **« Add deploy key »**
3. **Title** : `OpenJeff VPS`
4. **Cocher « Allow write access »** (sans ça, push impossible)
5. Coller cette clé publique :
   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJv64EzJXt45JQgxdOjWDeDshz2qXHYu0i1iu6zfTzhK galaxia-vps-openjeff
   ```
6. Valider, puis dire « go » dans le chat — je pousse immédiatement les 11 commits prêts.

**Alternative** si tu préfères : créer un Personal Access Token GitHub fine-grained avec scope `Contents: write` sur ce repo, et me le donner en variable d'env — je passe en HTTPS push. Moins propre (token plus puissant qu'une deploy key scoped au repo), mais plus rapide si la deploy key te bloque.

---

## 3. UPDATES.md — mécanisme de release

**Posée le :** 2026-05-21
**Statut :** ouverte (5 sous-questions liées)

Mon design proposé dans [`docs/UPDATES.md`](docs/UPDATES.md) recommande l'option A (registry Docker privé sur la mère, manifestes signés cosign). À valider, plus 4 sous-questions :

- Option A confirmée, ou tu préfères B (OCI artifacts statiques sur Caddy) / C (git pull) ?
- Rythme des releases : hebdo, mensuel, au fil de l'eau ?
- Fréquence du pull côté galaxies filles : quotidien, horaire, hebdo ?
- Rollback : auto sur healthcheck KO ou manuel uniquement ?
- Modules premium : intégrés au manifeste (avec auth), ou registry séparé `premium.galaxia-os.com` ?

Impact : c'est l'architecture du Hub & Spoke. Une fois posée elle change peu.

---

## 4. DNS galaxia-os.com — sous-domaines manquants

**Posée le :** 2026-05-21
**Statut :** ouverte (action côté OVH)

Au 2026-05-22, seuls `galaxia-os.com` et `app.galaxia-os.com` répondent (188.34.188.200). Les autres ne sont pas propagés :
- `updates.galaxia-os.com` — endpoint Hub & Spoke
- `install.galaxia-os.com` — `curl | bash` public d'install
- `docs.galaxia-os.com` — documentation
- `n8n.galaxia-os.com` (si tu choisis l'option A en question 2)

**Ce que j'ai besoin de toi :** ajouter les enregistrements A (et AAAA pour `2a01:4f8:1c17:65af::1` si tu veux IPv6 public) côté OVH. Préviens-moi quand c'est fait, j'active les vhosts Caddy.

---

## 5. Licence du projet

**Posée le :** 2026-05-21
**Statut :** ouverte

Le README mentionne "à définir, probablement AGPLv3".

AGPLv3 protège le caractère ouvert même contre les fork hébergés en SaaS (idéal pour l'identité "produit fini distribuable, pas SaaS"). Alternatives : Apache 2.0 (plus permissive, adoption plus large mais SaaS fork possible), MIT (idem).

**Ma reco :** AGPLv3 pour le core + licences commerciales pour les modules premium.

Décision attendue avant le premier push GitHub public.

---

## 6. Stratégie clés API LLM côté PME

**Posée le :** 2026-05-22
**Statut :** ouverte

Le briefing global mentionne 3 modes de confidentialité (cloud anonymisé / hybride / 100% local) et 4 providers possibles (Claude, GPT, Gemini, Ollama). Côté PME, comment on collecte/stocke leurs clés ?

Options :
- **A.** Wizard d'install demande la clé du provider choisi, stockage dans `/opt/galaxia/config/.env` chmod 600.
- **B.** Wizard demande, stockage dans un secret manager local (`pass`, `age` chiffré).
- **C.** Mode 100% Ollama par défaut, configuration des clés cloud uniquement via UI plus tard.

Impact : UX du wizard + sécu locale chez la PME.

---

## 7. NemoClaw — protocole d'install validé

**Posée le :** 2026-05-22
**Statut :** ✅ résolue (option 1 choisie le 2026-05-22)

Décision : install via Docker isolé d'abord (script téléchargé sans pipe, lu, puis exécuté en sandbox).

→ Vérification chaîne d'origine faite, légitime (Akamai NVIDIA → GitHub NVIDIA/NemoClaw). Sandbox d'éval dans `ops/sandbox/nemoclaw/` a confirmé le comportement de l'installer. Install sur OpenJeff effectuée : `nemoclaw v0.0.48` + `openshell v0.0.39` opérationnels, sandbox `galaxia-main` Ready, inference routée vers Ollama llama3.1:8b. Voir [`docs/STATUS.md`](docs/STATUS.md) § NemoClaw pour le détail.

---

## 8. Accès au dashboard NemoClaw — pattern UI pour Galaxia

**Posée le :** 2026-05-22
**Statut :** ouverte (impact UX bloquant pour `app.galaxia-os.com`)

NemoClaw n'expose **PAS** son dashboard (port 18789) sur l'hôte par design — c'est dans le sub-namespace réseau du sandbox OpenShell pour des raisons de sécurité (Landlock + isolation). Or le briefing prévoyait `app.galaxia-os.com` comme UI principale de la Galaxia mère, et chaque PME aura besoin de la même chose en local.

Trois options à trancher :

- **A. Cloudflared tunnel (pattern natif NemoClaw)** — `nemoclaw tunnel start` lance un tunnel Cloudflare qui expose le dashboard sur `<sub>.trycloudflare.com` (ou un domaine custom Cloudflare). Marche partout (PME derrière NAT inclus), gratuit pour usage perso, mais dépend d'un service tiers (rompt légèrement la promesse "souverain").

- **B. Reverse proxy Caddy → openshell port-forward** — utiliser `openshell port-forward galaxia-main 18789:18789` (à confirmer si la syntaxe existe) pour exposer le dashboard à l'hôte, puis Caddy `app.galaxia-os.com → 127.0.0.1:18789`. Souverain (rien ne sort), mais nécessite que la PME ait un domaine public + DNS, et donc un setup plus poussé que l'idéal "manager non-tech".

- **C. SSH tunnel local depuis le poste du manager** — pas d'exposition publique, le manager se connecte via `ssh -L 18789:127.0.0.1:18789 galaxia@<ip>` depuis son laptop, et accède via `http://localhost:18789`. Souverain et simple, mais demande un client SSH côté manager (Windows tricky sans gros guide).

**Ma reco :** B + un fallback A pour les PME sans DNS public. Le briefing dit "manager non-tech doit pouvoir installer seul" → A serait plus simple à démarrer, B est la finalité une fois le domaine en place.

Impact : c'est le mode d'accès principal au produit. Tranche en premier sur cette question, le reste de l'UI Galaxia (branding, wizard CLI) découle de là.

---

## 9. Plugin `nemoclaw` du gateway — bug JSON

**Posée le :** 2026-05-22
**Statut :** info, pas bloquant

Le sandbox tourne avec 4 plugins (browser, device-pair, phone-control, talk-voice) sur 5 prévus — le 5e (`nemoclaw`) échoue à charger : `SyntaxError: Unexpected end of JSON input` lors du register depuis `/sandbox/.openclaw/extensions/nemoclaw/dist/index.js`.

Probablement un bug upstream NemoClaw (early preview 2026-03-16). À reporter sur https://github.com/NVIDIA/NemoClaw/issues, ou à investiguer pour patch local si on en a besoin pour des features Galaxia.

Pas bloquant pour démarrer, mais à suivre.
