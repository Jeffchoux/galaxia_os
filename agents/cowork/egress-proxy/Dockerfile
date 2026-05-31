# Galaxia Cowork — image du proxy d'egress filtré (tinyproxy).
#
# Image : galaxia/cowork-egress-proxy
#
# Démon unique, attaché à DEUX réseaux par le service galaxia-cowork-egress :
#   - cowork-egress (INTERNE, sans NAT)  : seul lien des sandbox vers le proxy ;
#   - bridge (NAT)                       : le leg WAN du proxy vers Internet.
# Il n'autorise en sortie QUE les hôtes de allowlist.filter (cf. tinyproxy.conf).
#
# Souverain / packageable : buildé localement, aucune dépendance à un registre
# tiers à l'exécution. tinyproxy est dans Debian (apt), pas de pull externe.

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tinyproxy ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY allowlist.filter /etc/tinyproxy/allowlist.filter

EXPOSE 8888

# -d : reste au premier plan (supervisé par systemd via `docker run`), logs sur
# stdout/stderr -> journald. -c : notre conf durcie.
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
