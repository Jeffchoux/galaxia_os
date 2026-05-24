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

## 6. ✅ résolue le 2026-05-22 (autonomie) — voir [`docs/DECISIONS.md`](docs/DECISIONS.md)

Décision : **Option A** retenue par défaut (`.env` chmod 600 dans `/opt/galaxia/config/`), choix réversible (basculement possible vers `age`/`pass` plus tard sans casser le contrat). Tranchée en autonomie pour ne pas bloquer le wizard ; détails et trade-offs dans `docs/DECISIONS.md`.

---

## 7. NemoClaw — protocole d'install validé

**Posée le :** 2026-05-22
**Statut :** ✅ résolue (option 1 choisie le 2026-05-22)

Décision : install via Docker isolé d'abord (script téléchargé sans pipe, lu, puis exécuté en sandbox).

→ Vérification chaîne d'origine faite, légitime (Akamai NVIDIA → GitHub NVIDIA/NemoClaw). Sandbox d'éval dans `ops/sandbox/nemoclaw/` a confirmé le comportement de l'installer. Install sur OpenJeff effectuée : `nemoclaw v0.0.48` + `openshell v0.0.39` opérationnels, sandbox `galaxia-main` Ready, inference routée vers Ollama llama3.1:8b. Voir [`docs/STATUS.md`](docs/STATUS.md) § NemoClaw pour le détail.

---

## 8. ✅ résolue le 2026-05-22 — voir [`docs/DECISIONS.md`](docs/DECISIONS.md)

Décision : **A par défaut** (tunnel natif NemoClaw), **B en cible** (Caddy + port-forward) une fois domaine PME branché. Pas de C (SSH tunnel).

---

## 10. Frontière OSS gratuit / modules premium payants

**Posée le :** 2026-05-22
**Statut :** ouverte (pas bloquante court terme, structurante moyen terme)

Le brief dit : « open source gratuit à la base, freemium avec modules premium payants ». Trois sous-décisions liées qui doivent être prises avant qu'on accepte une contribution externe ou qu'on publie le premier module premium :

1. **Repos** : tout dans `galaxia_os` (un seul repo public, modules premium en sous-dossier sous licence commerciale) ou repo séparé `galaxia-premium` (privé) que la galaxie mère packagera pour les clients payants ?
2. **CLA** : exiger un Contributor License Agreement (relicensable) pour pouvoir intégrer du code de contributeurs dans la base premium future ? Sans ça, on se ferme la porte à utiliser une contribution OSS dans un module payant.
3. **Frontière fonctionnelle** : qu'est-ce qui est gratuit (core agent, wake word, wizard, intégrations Claude/GPT/Gemini/Ollama, dashboard de base) vs payant (multi-utilisateur SSO ? Audit log conforme RGPD ? Modules métier sectoriels — RH, comptabilité, juridique ? Support prioritaire ?) ?

**Ma reco par défaut (à valider) :**
- Repo unique `galaxia_os` AGPLv3 pour le core, dossier `premium/` avec sa propre licence commerciale (BSL ou similar) — un seul `git clone` côté PME, le wizard active/désactive les modules premium selon une licence-key.
- CLA léger type « tu donnes le droit à Galaxia de relicensier sous toute licence » (modèle Plausible / Sentry).
- Premium = audit RGPD + modules métier ; tout le reste reste libre.

Décision peut attendre jusqu'au premier module premium concret. Le notant ici pour qu'on n'oublie pas.

---

## 9. Plugin `nemoclaw` du gateway — bug JSON

**Posée le :** 2026-05-22
**Statut :** info, pas bloquant

Le sandbox tourne avec 4 plugins (browser, device-pair, phone-control, talk-voice) sur 5 prévus — le 5e (`nemoclaw`) échoue à charger : `SyntaxError: Unexpected end of JSON input` lors du register depuis `/sandbox/.openclaw/extensions/nemoclaw/dist/index.js`.

Probablement un bug upstream NemoClaw (early preview 2026-03-16). À reporter sur https://github.com/NVIDIA/NemoClaw/issues, ou à investiguer pour patch local si on en a besoin pour des features Galaxia.

Pas bloquant pour démarrer, mais à suivre.

---

## 11. (D1 roadmap) Provider mail pour le magic link de connexion

**Posée le :** 2026-05-24
**Statut :** ouverte — **bloque Sprint 2** (S24-S25)

Quand on ouvre le cockpit aux utilisateurs PME (au-delà de Jeff seul), il faut un système de magic link (lien temporaire envoyé par mail) pour éviter de gérer des mots de passe par utilisateur. Il faut donc un provider mail qui envoie un email transactionnel à la demande, avec une bonne réputation IP pour ne pas finir en spam.

**Options :**

| Provider     | Origine | Plan gratuit            | Note                                              |
|--------------|---------|-------------------------|---------------------------------------------------|
| **Brevo** (ex-Sendinblue) | FR      | 300 emails/jour à vie    | Reco — souverain (RGPD natif), API claire, SDK Node maintenu |
| Resend       | US      | 3000/mois (100/jour)    | DX excellente, mais hébergement US (RGPD via SCC) |
| AWS SES      | US      | 62k/mois (depuis EC2)   | Le moins cher à l'échelle, mais configuration DKIM/SPF lourde |
| Postmark     | US      | 100/mois free           | Excellente réputation IP, mais payant vite        |
| SMTP perso (Postfix sur le VPS) | local | gratuit | Mauvais delivery (IP VPS Hetzner souvent flag), à proscrire |

**Ma reco (cf. ROADMAP Q3 D1) :** **Brevo**. Cohérent avec l'identité souveraine du produit, freemium 300/jour suffit pour un pilote PME (le pic d'envoi = un login par utilisateur par jour), et on peut switcher de provider plus tard sans changer l'UX.

**Impact si pas tranché :** je peux développer le magic link contre une interface abstraite (`sendMagicLink(email, token)`) et brancher Brevo par défaut. Tu peux toujours basculer en éditant `.env`. Donc je peux avancer sur Sprint 2 même sans réponse, mais la décision finale doit être prise avant la 1re PME pilote (Sprint 3).

---

## 12. (D2 roadmap) Identification de la PME pilote

**Posée le :** 2026-05-24
**Statut :** ouverte — **TOUT le plan trimestriel repose dessus**

Sprint 3 (S26-S27) = installer Galaxia chez une **vraie** PME pilote (vrais utilisateurs, vrais documents). Tout le reste de la roadmap suppose que ce déploiement aura lieu. Si pas de PME identifiée fin juin, Sprints 4-5-6 deviennent du dev spéculatif.

**Options :**

- **(a) Réseau perso Jeff** — démarcher 3-5 PME que tu connais déjà (clients existants, contacts BabyRun, anciens collègues). Avantage : confiance préexistante, retour terrain rapide, pas de cycle commercial. Inconvénient : tu dois mobiliser ce capital relationnel.
- **(b) Démarchage froid LinkedIn / cold mail** — cibler des dirigeants PME 10-50 personnes intéressés par l'IA. Long, faible taux de réponse, mais scalable.
- **(c) Communauté open-source** — annoncer Galaxia sur HackerNews/r/selfhosted/communautés FR, attendre qu'une PME tech-savvy se manifeste. Risque : un early adopter technicien n'a pas le même profil qu'une PME pilote représentative.
- **(d) Pas de PME en Q3, dogfooding intensif Jeff** — utiliser Galaxia toi-même à temps plein 8 semaines, repousser le pilote à Q4. Solide pour itérer, mais retarde la validation produit-marché.

**Ma reco (cf. ROADMAP Q3 D2) :** **(a)** d'abord, **(b)** en backup. Date butoir : **2026-06-21** (fin S25). Si à cette date pas de candidat ferme : bascule Sprint 3 sur (d) + (b) en parallèle.

**Action côté toi :** dès que tu as un candidat sérieux (≥ 1 entretien tenu), me le dire dans le chat avec : nom PME, secteur, taille (nb users à provisionner), domaine personnalisé souhaité, qui est le sponsor interne.

---

## 13. (D3 roadmap) LLM par défaut dans le cockpit

**Posée le :** 2026-05-24
**Statut :** ouverte — impact UX direct + facturation Anthropic

Aujourd'hui le cockpit utilise `claude-opus-4-7` par défaut (`COCKPIT_MODEL` surchargeable). Opus est le plus capable mais aussi le plus cher (≈ 5× Sonnet). Quand on ouvre aux utilisateurs PME, ça peut exploser la facture si Jeff finance les requêtes Anthropic (modèle Hub & Spoke = chaque fille a ses propres clés API, donc en théorie chaque PME paie ses tokens, mais pour le pilote on va probablement leur prêter une clé).

**Options :**

- **(a) Garder Opus par défaut.** Simple, max qualité, mais coût élevé.
- **(b) Sonnet par défaut + bouton "Opus" et "Local" opt-in par message.** L'utilisateur choisit explicitement quand il veut Opus (ex : tâche complexe) ou local Ollama (ex : info sensible). Cohérent avec l'identité souveraine (le local existe vraiment côté UX).
- **(c) Local par défaut, escalade Sonnet/Opus à la demande.** Plus économique mais qualité de réponse perçue dégradée d'entrée — risque de premier contact négatif.

**Ma reco (cf. ROADMAP Q3 D3) :** **(b)** — Sonnet par défaut, 3 boutons visibles (Local / Sonnet / Opus). C'est aussi cohérent avec l'anti-pattern roadmap n°7 : "max 3 LLM providers visibles dans l'UI".

**Impact si pas tranché :** j'avance Sprint 2 multi-user en gardant Opus par défaut comme aujourd'hui, et je rajoute le sélecteur en Sprint 4 (boucle retour pilote). Donc on peut décider plus tard, mais avant d'ouvrir au-delà de toi.
