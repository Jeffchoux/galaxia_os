# ops/systemd — units systemd Galaxia

Units versionnées dans le repo, à symlinker dans `/etc/systemd/system/` côté
hôte. Permet de modifier la config (timer, env vars, hardening) en commitant
un diff plutôt qu'en éditant `/etc/`.

## Units disponibles

| Unit                          | Rôle                                        |
|-------------------------------|---------------------------------------------|
| `galaxia-veille.service`      | Exécution one-shot du job de veille IA      |
| `galaxia-veille.timer`        | Déclencheur quotidien (06:30 UTC) du service |

## Installation (galaxie mère, OpenJeff)

```bash
# 1. Symlinks dans /etc/systemd/system/ — pointer vers le repo, pas copier
sudo ln -sf /home/galaxia/galaxia-project/ops/systemd/galaxia-veille.service \
            /etc/systemd/system/galaxia-veille.service
sudo ln -sf /home/galaxia/galaxia-project/ops/systemd/galaxia-veille.timer \
            /etc/systemd/system/galaxia-veille.timer

# 2. Recharger systemd, activer + démarrer le timer
sudo systemctl daemon-reload
sudo systemctl enable --now galaxia-veille.timer

# 3. Vérifier
systemctl status galaxia-veille.timer
systemctl list-timers galaxia-veille.timer
```

## Déclencher la veille manuellement

```bash
sudo systemctl start galaxia-veille.service
# Suivre en direct :
journalctl -u galaxia-veille.service -f
# Voir le dernier rapport :
cat /home/galaxia/galaxia-project/docs/veille/$(date -u +%F).md
```

## Désinstaller

```bash
sudo systemctl disable --now galaxia-veille.timer
sudo rm /etc/systemd/system/galaxia-veille.{service,timer}
sudo systemctl daemon-reload
```

## Notes hardening

Les units appliquent `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`
et `ProtectHome=read-only`. Le service ne peut écrire que dans
`/home/galaxia/galaxia-project/docs/veille/` (déclaré via `ReadWritePaths`).
Si on ajoute d'autres sorties (logs, cache HTTP), il faudra étendre cette
liste.

À reproduire côté galaxies filles avec les chemins adaptés au layout PME
(probablement `/opt/galaxia/agents/veille/` quand on packagera).
