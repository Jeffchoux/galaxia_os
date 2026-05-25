# Wake word — fichiers Porcupine

Ce dossier reçoit les artefacts Picovoice Porcupine consommés par le client
(cf. `src/lib/client/porcupine.ts` et Sprint 3 § A.1 dans
`docs/ROADMAP-Q3-2026.md`). Les `.ppn` et `.pv` sont **gitignored** —
chaque déploiement doit poser les siens.

## Fichiers attendus

| Fichier                       | Source                                                                 |
|-------------------------------|------------------------------------------------------------------------|
| `hey_galaxia_fr.ppn`          | Console Picovoice → Train Wake Word → langue FR, phrase "Hey Galaxia"  |
| `porcupine_params_fr.pv`      | https://github.com/Picovoice/porcupine/tree/master/lib/common (params_fr.pv) |

## Procédure (Jeff, ~5 min, une seule fois)

1. Créer un compte free sur https://console.picovoice.ai/ (Google/GitHub login).
2. Onglet **AccessKey** → copier la clé `XXXXXXXX==`, la mettre dans
   `apps/cockpit/.env` sous `PUBLIC_PICOVOICE_ACCESS_KEY=`.
3. Onglet **Porcupine** → **Train Wake Word** → "Hey Galaxia", langue **Français** → "Train".
4. Télécharger le `.ppn` produit, le renommer `hey_galaxia_fr.ppn`, le déposer ici.
5. Télécharger les params FR multi-mots-clés :
   ```
   curl -L -o porcupine_params_fr.pv https://raw.githubusercontent.com/Picovoice/porcupine/master/lib/common/porcupine_params_fr.pv
   ```
6. Relancer `npm run dev` ou le service systemd (`sudo systemctl restart galaxia-cockpit`).

Sans ces fichiers + sans la clé `PUBLIC_PICOVOICE_ACCESS_KEY`, le client
**retombe automatiquement** sur le filtre regex actuel — aucune régression.
