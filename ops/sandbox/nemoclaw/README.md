# Sandbox d'évaluation NemoClaw

> Pas une image de production Galaxia. Juste un test isolé pour observer ce que
> fait l'installer officiel NVIDIA avant de l'engager sur le VPS OpenJeff.

## Usage

```bash
./run.sh             # build (si nécessaire) + run
./run.sh --rebuild   # force rebuild de l'image
```

Logs : `./logs/run-<timestamp>.log` (ignorés par git).

## Pourquoi cette sandbox

Le briefing Galaxia demande que tout artefact distribuable passe par Docker.
Avant d'installer NemoClaw sur l'hôte OpenJeff "à nu", on observe ce qu'il
fait dans un container jetable :

- Quelles URLs il appelle
- Quelles dépendances système il essaie d'installer
- Où il bloque sur des choses spécifiques à l'hôte (Docker daemon, systemd, GPU)
- Quels fichiers il dépose en user-space

## Observations (2026-05-22)

Première exécution dans `galaxia/nemoclaw-test:isolated` (Ubuntu 24.04 + curl +
git + sudo + Node deps, user `tester` UID 1100 avec NOPASSWD, sans Docker
préinstallé). Variables d'env :
`NEMOCLAW_NON_INTERACTIVE=1`, `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1`,
`NEMOCLAW_PROVIDER=ollama`, `NEMOCLAW_NO_EXPRESS=1`.

### Ce qui a fonctionné

1. **Bootstrap** `curl -fsSL https://www.nvidia.com/nemoclaw.sh` → 301 Akamai → `raw.githubusercontent.com/NVIDIA/NemoClaw` (≈5.8 KB)
2. **Banner officiel** "NEMOCLAW — Launch OpenClaw in an OpenShell sandbox" affiché
3. **Étape Docker** : téléchargement de `https://get.docker.com` avec **SHA-256 affiché** (`3c2c1f7e9a3552b594b51b52d479a6c7ffdfd7e2d02a59845a0dc60ea9e71f45`), puis `apt-get install` de `docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras docker-buildx-plugin docker-model-plugin` — réussi
4. **`sudo usermod -aG docker tester`** → réussi
5. **Bailout propre** : message clair "Docker group membership is not active in this shell yet. Run newgrp docker, then re-run." Exit code 0.

### Ce qui a échoué (attendu)

- `sudo systemctl enable --now docker.service` → warning silencieux (pas de systemd dans le container, l'installer note "Could not enable docker.service — will verify daemon accessibility below")
- Le daemon Docker n'a pas démarré pour la même raison

### Ce qui n'a pas été testé

Comme l'installer bail à l'étape Docker (légitime), on n'a **pas observé** :
- Install de NVM (`~/.nvm`)
- Install de Node 24
- Install de NemoClaw via npm
- Création du sandbox OpenShell (`~/.openshell`)
- Onboarding (configuration provider Ollama, sandbox name, etc.)

`~/.nvm`, `~/.openshell`, NemoClaw : tous absents en fin de run.

### Signaux de sécurité

✅ Aucune URL externe en dehors de `nvidia.com`, `github.com`, `download.docker.com`
✅ SHA-256 du sub-script affiché avant exécution (transparence)
✅ Exit code 0 avec instructions claires de remédiation
✅ Aucun scan de `~/.ssh`, `~/.aws`, etc.
✅ Aucune écriture en dehors des chemins légitimes (`$HOME`, `/etc/apt`, `/etc/sudoers.d` via le script Docker officiel)

## Décision (task 5)

La sandbox valide :
- La chaîne d'origine est légitime
- L'installer est défensif et idempotent
- Aucun comportement suspect observé

**Prochain pas :** install sur OpenJeff hôte en compte `galaxia` (Docker déjà
actif chez nous, donc le bailout ne se produira pas — on verra Node/NVM/NemoClaw
s'installer pour de vrai). Une fois NemoClaw fonctionnel, on construit
l'image Docker de prod Galaxia qui l'embarque proprement.

## Limites du sandbox

- Pas de systemd → toute l'orchestration daemon échoue
- Pas de Docker-in-Docker → on ne peut pas voir NemoClaw créer son propre
  sandbox OpenShell
- Pour un test "complet" du sandbox NemoClaw, il faudrait soit `--privileged`
  + systemd container (genre `jrei/systemd-ubuntu:24.04`), soit DinD via
  `docker:dind` — overkill pour ce qu'on cherche à valider

Si à terme on doit reproduire la chaîne complète en sandbox (genre CI),
voir https://github.com/NVIDIA/NemoClaw pour les options officielles.
