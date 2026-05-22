# Galaxia

[![CI](https://github.com/Jeffchoux/galaxia_os/actions/workflows/ci.yml/badge.svg)](https://github.com/Jeffchoux/galaxia_os/actions/workflows/ci.yml)

**Écosystème IA souverain, open-source et gratuit pour les PME.**

Galaxia n'est pas un service en ligne. C'est un **produit fini que vous installez
sur votre propre serveur** (comme on installerait un logiciel). Vos données ne
sortent pas, vos clés API restent chez vous, et vous gardez la main sur tout.

Public visé : **le manager curieux non-informaticien** qui veut tester l'IA
chez lui avant d'engager son équipe. Pas besoin d'IT, pas besoin de développeur.

## Ce qui fait Galaxia

| Brique         | Rôle                                                                  |
|----------------|------------------------------------------------------------------------|
| **OpenClaw**   | Moteur d'agents IA (open-source, basé sur Claude — sorti janvier 2026) |
| **NemoClaw**   | Couche de sécurité NVIDIA enterprise par-dessus OpenClaw               |
| **Ollama**     | Exécution de modèles IA en local — option « 100 % chez vous »          |
| **Caddy**      | HTTPS automatique, exposition propre du dashboard                       |
| **Docker**     | Packaging reproductible — même image chez toutes les PME               |
| **Couche Galaxia** | Wake word « Hey Galaxia », agents PME, wizard FR manager-friendly  |

## 3 modes de confidentialité au choix de la PME

1. **Cloud anonymisé** — les LLMs cloud (Claude / GPT / Gemini) sont appelés, mais les données sensibles sont remplacées avant l'envoi.
2. **Hybride** — les tâches sensibles tournent en local sur Ollama, le reste passe par les LLMs cloud.
3. **100 % local** — tout reste sur votre serveur via Ollama. Zéro fuite.

Le mode est choisi au premier démarrage et peut être changé à tout moment via le wizard.

## Architecture — Hub & Spoke

- **1 Galaxia mère** (ce serveur) — fait la veille IA quotidienne, améliore les agents, publie les mises à jour.
- **N galaxies filles** — installations chez chaque PME, qui reçoivent les propositions de mise à jour et les acceptent ou refusent.

Détails dans [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) et [`docs/UPDATES.md`](docs/UPDATES.md).

## État du projet — où on en est aujourd'hui

⚠️ **Galaxia est en construction.** L'état réel des briques (ce qui tourne / ce qui manque) est documenté à chaque session dans [`docs/STATUS.md`](docs/STATUS.md).

Au 2026-05-22, sur la galaxie mère OpenJeff :
- ✅ Docker, Caddy, Ollama (llama3.1:8b), NemoClaw v0.0.48 + OpenShell v0.0.39 actifs
- ✅ Wizard FR d'install pour le manager non-dev ([`scripts/wizard.sh`](scripts/wizard.sh))
- ✅ Agent de veille IA quotidien (HackerNews + GitHub Trending + arXiv → synthèse FR via Ollama)
- 🔜 Mécanisme de mise à jour Hub & Spoke (design dans [`docs/UPDATES.md`](docs/UPDATES.md), implémentation en cours)
- 🔜 Sous-domaines `updates.` / `install.` / `docs.` (DNS en cours)

## Tester en local (mode développeur)

Le repo est utilisable tel quel pour explorer le code et faire tourner les briques individuelles :

```bash
git clone https://github.com/Jeffchoux/galaxia_os.git galaxia-project
cd galaxia-project

# Wizard de configuration (mode test, n'écrit pas dans /opt/galaxia)
GALAXIA_CONFIG_DIR=/tmp/galaxia-test bash scripts/wizard.sh

# Tests unitaires de l'agent de veille
cd agents/veille && node --test test/*.test.js
```

## Installer sur un serveur PME (galaxie fille)

À venir — l'installeur public sera publié sur `https://install.galaxia-os.com` une fois le DNS et le mécanisme d'updates en place. En attendant :

```bash
# Forme actuelle (sera simplifiée) :
curl -fsSL https://raw.githubusercontent.com/Jeffchoux/galaxia_os/main/scripts/install.sh | sudo bash
```

L'installeur (`scripts/install.sh`) installe Docker / Caddy / Ollama / NemoClaw, lance le wizard FR de configuration, et prépare la galaxie pour les mises à jour quotidiennes depuis la mère.

## Structure du dépôt

```
galaxia-project/
├── BRIEFING.md            ⭐ Vision et règles de travail (lire en premier)
├── CLAUDE.md              Garde-fous techniques pour les agents IA qui travaillent dessus
├── docs/
│   ├── STATUS.md          État réel des services (à jour à chaque session)
│   ├── ARCHITECTURE.md    Schéma Hub & Spoke
│   ├── UPDATES.md         Design du mécanisme de mise à jour
│   ├── DECISIONS.md       Choix tranchés (date + raison)
│   └── INTEGRATIONS.md    Outils tiers proposables à la PME
├── scripts/
│   ├── install.sh         Installeur galaxie fille
│   └── wizard.sh          Wizard FR manager-friendly
├── agents/veille/         Agent de veille IA quotidien (mère uniquement)
├── ops/systemd/           Units systemd (timer veille, à venir)
├── caddy/                 Configuration Caddy
└── docker-compose.yml     Orchestration des services Galaxia
```

## Contribuer

Le projet est jeune. La meilleure façon de contribuer aujourd'hui :

1. Ouvrir une issue avec votre cas d'usage PME — qu'est-ce qui vous aiderait vraiment au quotidien.
2. Tester l'install sur une VM Ubuntu / Debian fraîche et reporter ce qui casse.
3. Proposer des intégrations métier (RH, compta, juridique, marketing) — pour cibler les agents Galaxia.

Pour les contributions code, voir [`QUESTIONS_POUR_JEFF.md`](QUESTIONS_POUR_JEFF.md) § Q10 : la frontière OSS / modules premium et le CLA sont encore en cours de définition.

## Licence

À définir avant la première release publique. Préférence actuelle : **AGPLv3** pour le core (préserve le caractère ouvert même contre les fork hébergés en SaaS) + licences commerciales pour les futurs modules premium. Voir [`QUESTIONS_POUR_JEFF.md`](QUESTIONS_POUR_JEFF.md) § Q5.
