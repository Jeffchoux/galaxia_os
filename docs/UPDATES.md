# Mécanisme de mise à jour Hub & Spoke

> Statut : **design proposé + POC client livré**, à valider avec Jeff.
> Le client (`scripts/galaxia-update.sh`) marche end-to-end avec signature
> cosign vérifiée — voir § POC ci-dessous. Le serveur (registry ou static
> manifests) reste à choisir parmi A/B/C.

## Contraintes

Le modèle Hub & Spoke impose que :

1. **Une seule source de vérité** (la galaxie mère) publie les versions
2. Les N galaxies filles **pullent** (jamais de push depuis la mère vers les filles — chaque PME a sa propre IP, son propre firewall, et nous ne devons pas garder de credentials d'accès aux serveurs des PME)
3. Les mises à jour doivent être **vérifiables** (signature) — une PME ne doit pas pouvoir être empoisonnée par une fausse galaxie mère
4. Les mises à jour doivent **survivre aux pannes** : si le pull rate, la galaxie continue de fonctionner sur la version précédente
5. **Atomicité** : pas d'état "moitié mis à jour" qui casse la galaxie

## Options envisagées

### Option A — Docker registry privé sur la mère

`updates.galaxia-os.com` = un registry Docker (Distribution v2). Les filles font `docker pull` chaque jour.

**Pour :** standard, outillage mature, signature via cosign / Docker Content Trust.
**Contre :** registry à opérer, stockage des images sur la mère (volume), gestion des tags.

### Option B — OCI artifacts via une CDN statique

Les manifestes et layers Docker sont stockés comme des fichiers statiques servis par Caddy. Pas de registry à opérer.

**Pour :** mère reste simple (fichiers + Caddy), pas de service supplémentaire.
**Contre :** tooling moins mainstream, à coder en partie.

### Option C — Git pull du dépôt galaxia-project

Les filles font `git pull` sur ce dépôt + `docker-compose pull && up -d` pour les services.

**Pour :** simplicité maximale, historique versionné gratuit, déjà en place.
**Contre :** les images Docker doivent venir d'ailleurs (Docker Hub, GHCR), donc dépendance externe. Moins bien adapté à des modules premium fermés.

## Recommandation

**Option A (registry Docker privé sur la mère) couplée à un manifeste de version signé**.

Pourquoi :
- Cohérent avec l'identité de produit "fini distribuable" (les filles n'ont pas besoin de Git, juste de Docker)
- Pas de dépendance Docker Hub / GHCR (souveraineté)
- Outillage standard pour la signature (cosign + une clé publique embarquée dans l'installeur)
- Permet à terme de servir des modules premium fermés sans rendre le code public

## Esquisse technique

```
updates.galaxia-os.com
├── /v2/                              # API Docker Registry
│   ├── galaxia/core/manifests/v1.2.3
│   └── galaxia/core/blobs/...
├── /manifests/                       # Manifestes de version signés
│   ├── stable.yaml                   # → pointe sur v1.2.3
│   ├── beta.yaml                     # → pointe sur v1.3.0-rc1
│   └── v1.2.3.yaml.sig               # signature cosign
└── /install                          # Script d'install (curl | bash)
```

**Manifeste de version (`stable.yaml`) :**

```yaml
schema: 1
version: v1.2.3
released_at: 2026-05-21T18:00:00Z
images:
  core:     registry.galaxia-os.com/galaxia/core:v1.2.3@sha256:...
  agent:    registry.galaxia-os.com/galaxia/agent:v1.2.3@sha256:...
  ollama:   ollama/ollama:0.4.2
notes_url: https://docs.galaxia-os.com/releases/v1.2.3
```

**Workflow côté galaxie fille (cron 03:30 daily) :**

```
1. curl https://updates.galaxia-os.com/manifests/$CHANNEL.yaml → tmp
2. curl https://updates.galaxia-os.com/manifests/$CHANNEL.yaml.sig → tmp
3. cosign verify --key /opt/galaxia/keys/galaxia-os.pub manifest.yaml
4. compare manifest.version vs current → si égal, exit 0
5. docker-compose pull (utilise les digests sha256 du manifest)
6. docker-compose up -d (atomique via Docker)
7. healthcheck post-up → si KO, docker-compose down + restore version N-1
8. log dans /opt/galaxia/logs/update.log
```

## Versioning

SemVer strict : `MAJOR.MINOR.PATCH` (+ `-rc.N` pour les pre-release).
Canaux : `stable` (default), `beta`, `edge`.

## POC client (`scripts/galaxia-update.sh`) — livré 2026-05-22

Le client galaxie fille est implémenté et testé end-to-end. Il est volontairement
indépendant du choix A/B/C : il fetch un manifeste JSON + sa signature détachée,
vérifie avec cosign (clé publique embarquée), compare la version, et déclenche
le `docker compose pull && up -d` si différence.

**Pourquoi JSON et pas YAML** : parsable en bash via `python3 -c` (stdlib),
pas de dépendance `yq` à installer côté PME. Le contenu reste le même.

**Pourquoi cosign v2** : v2 a un flow air-gapped trivial (`--tlog-upload=false`
+ `--insecure-ignore-tlog`). v3 force `signing-config` — adresseable mais
plus de friction. Côté Galaxia on est en modèle « clé publique de confiance
embarquée dans l'installeur », pas en modèle Rekor transparency log. La clé
publique = la racine de confiance.

**Validé en CI** :
- Happy path : manifeste signé valide → VERSION écrit
- Idempotence : second run, même version → no-op exit 0
- Signature corrompue → refuse, VERSION non écrit, exit 1

**Reste à câbler après la décision Q3** :
- L'URL `updates.galaxia-os.com` (DNS + serveur)
- La génération initiale du keypair côté mère (`/opt/galaxia/keys/galaxia-os.{key,pub}`)
- La distribution de la clé publique aux galaxies filles (probablement dans
  l'image de l'installeur, signée par sa propre chaîne TLS au moment du
  `curl install.galaxia-os.com`)
- Le mécanisme de rotation de clé (rare mais à prévoir)

**Test local rapide :**

```bash
# Générer un keypair de test
mkdir -p /tmp/galaxia-poc-keys && cd /tmp/galaxia-poc-keys
COSIGN_PASSWORD='' cosign generate-key-pair

# Préparer un manifeste signé
mkdir -p /tmp/galaxia-fixture
cat > /tmp/galaxia-fixture/stable.json <<'EOF'
{"schema":1,"version":"v0.1.0-test","channel":"stable","images":{},"notes":"test"}
EOF
COSIGN_PASSWORD='' cosign sign-blob --yes --tlog-upload=false \
  --key /tmp/galaxia-poc-keys/cosign.key \
  --output-signature /tmp/galaxia-fixture/stable.json.sig \
  /tmp/galaxia-fixture/stable.json

# Lancer l'update
GALAXIA_DIR=/tmp/galaxia-poc-install \
GALAXIA_UPDATE_FIXTURE=/tmp/galaxia-fixture \
COSIGN_PUBKEY=/tmp/galaxia-poc-keys/cosign.pub \
bash scripts/galaxia-update.sh
```

## Questions ouvertes (pour Jeff)

- [ ] Option A confirmée vs B/C ?
- [ ] Rythme des releases (hebdo / au fil de l'eau / mensuel) ?
- [ ] Fréquence du pull côté filles (quotidien suffit, ou horaire pour les patches critiques) ?
- [ ] Stratégie de rollback : auto sur healthcheck KO, ou manuel uniquement ?
- [ ] Modules premium : intégrés dans le manifest (avec auth), ou registry séparé `premium.galaxia-os.com` ?
