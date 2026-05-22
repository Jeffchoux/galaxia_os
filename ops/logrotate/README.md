# ops/logrotate — rotation des logs Galaxia

Pour éviter le disque-full silencieux sur une galaxie fille qui tourne
plusieurs mois sans intervention.

## Politique

- `/opt/galaxia/logs/*.log` : weekly, 8 rotations conservées, gzip avec
  delay (le `.log.1` reste lisible non-compressé pour debug rapide),
  owner `galaxia:galaxia`.
- Caddy et systemd (galaxia-veille, galaxia-update) loguent via journald —
  géré par la rotation systemd, pas par cet outil.

## Installation

```bash
sudo ln -sf /home/galaxia/galaxia-project/ops/logrotate/galaxia \
            /etc/logrotate.d/galaxia
# Test à blanc :
sudo logrotate -d /etc/logrotate.d/galaxia
```

À reproduire côté galaxies filles, avec les chemins ajustés à
`/opt/galaxia/...` (déjà compatible avec la cible standard de
`scripts/install.sh`).
