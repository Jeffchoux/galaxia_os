# ops/systemd — units systemd Galaxia

Units versionnées dans le repo, à symlinker dans `/etc/systemd/system/` côté
hôte. Permet de modifier la config (timer, env vars, hardening) en commitant
un diff plutôt qu'en éditant `/etc/`.

## Units disponibles

| Unit                          | Rôle                                                                |
|-------------------------------|----------------------------------------------------------------------|
| `galaxia-veille.service`      | Veille IA quotidienne (HN/GitHub/HF/arXiv → Ollama → markdown)       |
| `galaxia-veille.timer`        | Déclencheur de la veille (06:30 UTC + rand 5 min) — mère uniquement  |
| `galaxia-coder.service`       | Coder agent — lit la veille, ouvre 1-3 PRs sur le repo (Claude API)  |
| `galaxia-coder.timer`         | Déclencheur du coder (07:00 UTC + rand 5 min) — mère uniquement      |
| `galaxia-update.service`      | Pull + verify + apply d'une mise à jour signée (galaxia-update.sh)   |
| `galaxia-update.timer`        | Déclencheur d'update (03:30 UTC + rand 15 min) — galaxie fille       |

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

## Mise à jour Hub & Spoke — galaxia-update.timer (galaxie fille)

Posé automatiquement par `scripts/install.sh` (fonction `install_update_runtime`).
Pour le poser à la main sur une galaxie fille existante :

```bash
sudo install -m 0755 /home/galaxia/galaxia-project/scripts/galaxia-update.sh /usr/local/bin/galaxia-update
sudo install -m 0644 /home/galaxia/galaxia-project/ops/systemd/galaxia-update.service /etc/systemd/system/
sudo install -m 0644 /home/galaxia/galaxia-project/ops/systemd/galaxia-update.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now galaxia-update.timer
systemctl list-timers galaxia-update.timer
```

Pré-requis sur la galaxie fille avant que le timer puisse réussir un cycle :
- `cosign v2.x` installé (cf. `install.sh` § `install_cosign`)
- `/opt/galaxia/keys/galaxia-os.pub` présent (clé publique de signature)
- `updates.galaxia-os.com` accessible (DNS + Caddy côté mère)

Sans ces pré-requis le service échoue proprement (exit 1) et le timer
retentera le lendemain. Aucun risque d'état "moitié appliqué".
