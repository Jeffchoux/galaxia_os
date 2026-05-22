# Ubuntu 24.04 vanille pour tester scripts/install.sh en mode E2E.
# On installe juste ce qu'il faut pour que install.sh tourne en mode test
# (GALAXIA_INSTALL_TEST_MODE=1) : pas docker, pas caddy, pas ollama, pas
# nemoclaw — ces étapes sont skippées dans le mode test.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Outils requis par install.sh même en test mode :
# - curl/ca-certificates pour télécharger cosign
# - sudo pour le wizard
# - bash (déjà présent)
# - systemd-sysv pour avoir le binaire systemctl (qui ne pourra rien faire
#   mais install.sh gère ça en best-effort avec warn)
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        curl ca-certificates sudo systemd-sysv && \
    rm -rf /var/lib/apt/lists/*

# Copie le repo dans /src — chemin distinct de /opt/galaxia pour ne pas
# masquer les comportements d'install.
COPY . /src
WORKDIR /src

CMD ["bash", "/src/ops/e2e/run-test.sh"]
