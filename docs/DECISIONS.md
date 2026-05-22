# Décisions Galaxia

> Journal des choix tranchés. Les blocs viennent de
> [`../QUESTIONS_POUR_JEFF.md`](../QUESTIONS_POUR_JEFF.md) une fois résolus,
> avec la date et la réponse de Jeff. Lecture utile pour comprendre
> pourquoi le code/l'infra sont configurés comme ils sont.

---

## 2026-05-22 — Q1 : repo GitHub (partiellement)

**Posée le :** 2026-05-21
**Tranchée le :** 2026-05-22

**Décision** : repo GitHub = `https://github.com/Jeffchoux/galaxia_os.git`
(compte personnel de Jeff, nom `galaxia_os` avec underscore — différent du
domaine `galaxia-os.com` avec hyphen).

**Conséquence dans le code** :
- `git remote set-url origin git@github.com:Jeffchoux/galaxia_os.git`

**Suite** : la deploy key SSH générée précédemment (`galaxia_github_ed25519`)
**n'a pas accès** à ce repo — elle pointait vers un chemin imaginé `galaxia-os/galaxia` qui n'existe pas. Le push restera bloqué tant que Jeff
n'aura pas ajouté la clé publique aux **Settings → Deploy keys** du repo
`Jeffchoux/galaxia_os` avec **Read+Write**. Une note de suite reste
dans `QUESTIONS_POUR_JEFF.md` § Q1bis.

---

## 2026-05-22 — Q2 : n8n hérité du provisioning

**Posée le :** 2026-05-21
**Tranchée le :** 2026-05-22
**Réponse de Jeff** : « je ne sais pas »

**Décision** : container `n8n_n8n_1` **arrêté** sans destruction, volume `n8n_n8n_data` **conservé**, port UFW 5678 **fermé**. Réversible — si Jeff se souvient d'un usage actif, `cd /opt/n8n && docker-compose start` le réveille.

**Conséquence dans l'infra** :
- `docker stop n8n_n8n_1` (compose intact à `/opt/n8n/docker-compose.yml`)
- `ufw delete allow 5678/tcp` (sortie publique fermée)
- Volume Docker `n8n_n8n_data` préservé (~20 Mo, négligeable)

**Suivi** : si rien n'est réactivé d'ici fin juin 2026, supprimer définitivement (`docker-compose down -v && rm -rf /opt/n8n`).
