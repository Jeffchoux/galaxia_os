# Sandbox d'évaluation NemoClaw — pas une image de production Galaxia.
#
# Objectif : exécuter l'installer NemoClaw officiel dans un environnement
# isolé pour observer (a) ce qu'il télécharge, (b) ce qu'il installe en
# user-space, (c) où il bloque sur des opérations système (Docker daemon,
# systemd, GPU NVIDIA) qu'on simulera ensuite ailleurs.
#
# Limites connues de ce sandbox :
#   - Pas de systemd → les `systemctl enable` échoueront silencieusement
#   - Pas de Docker-in-Docker → l'étape d'install de Docker échouera (volontaire)
#   - Pas de GPU NVIDIA → la branche CDI sera skip
#
# Ces échecs sont attendus et informatifs. Le but n'est pas de réussir
# l'install dans le sandbox, mais d'inventorier ses étapes pour l'orchestrer
# proprement côté hôte OpenJeff ensuite.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Dépendances de l'installer (curl, git, build-essential pour npm native modules,
# xz-utils pour les tarballs Node, sudo pour les promotions internes du script)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        gnupg \
        sudo \
        less \
        xz-utils \
        build-essential \
        python3 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Utilisateur non-root (l'installer NemoClaw préfère ne pas tourner en root)
RUN useradd --create-home --shell /bin/bash --uid 1100 tester \
 && echo 'tester ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/tester \
 && chmod 0440 /etc/sudoers.d/tester

USER tester
WORKDIR /home/tester

# Le script d'install lui-même n'est PAS embarqué — il est récupéré au
# moment du run depuis NVIDIA, exactement comme une PME le ferait.
# Voir run.sh pour la commande de lancement.
CMD ["bash", "-lc", "echo 'Lancez via run.sh, pas docker run direct.'"]
