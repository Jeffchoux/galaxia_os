# Browser smoke test — cockpit Galaxia

Petit test Playwright qui drive un Chromium headless contre le cockpit
(par défaut `https://app.galaxia-os.com`) pour valider que la surface
publique ne casse pas en prod : login render, auth gate, routes
protégées, assets statiques, aucune erreur JS console.

Volontairement limité à la **surface non-authentifiée** — on ne sauve
pas de mot de passe dans le repo. Pour des tests authentifiés (chat,
voix, drag-drop), brancher manuellement un cookie session.

## Premier setup

```bash
cd ops/browser-smoke
npm install
npm run install:browser     # télécharge Chromium (~115 Mo)
sudo npm run install:deps   # installe libnss3, libnspr4, etc. (apt)
```

## Lancer le test

```bash
npm test                                              # contre prod
BASE_URL=http://127.0.0.1:3000 npm test               # contre local
```

Sortie attendue (toute coche verte) :

```
=== Galaxia cockpit — browser smoke (https://app.galaxia-os.com) ===

  ✓ GET / → 200 + redirige vers /login — 621ms, dest=/login?next=/
  ✓ Login title contient "Galaxia" — Galaxia — connexion
  ✓ Login h1 contient "Galaxia" — Galaxia
  ✓ Champ <input type=password> présent
  ✓ Bouton <button type=submit> présent
  ✓ GET /documents → 200 → /login
  ✓ GET /briefs → 200 → /login
  ✓ GET /api/conversations → 200 → /login
  ✓ POST /api/tts sans cookie : pas d'audio servi (auth gate OK)
  ✓ GET /favicon.ico → 200
  ✓ GET /manifest.webmanifest → 200
  ✓ 0 erreur JS au chargement du login

=== Résultat : 12 passed, 0 failed ===
```

Screenshots persistés dans `out/` (gitignoré).

## Ce qui n'est PAS couvert

- Le chat authentifié (streaming SSE, tool_use loop, mémoire)
- Le wake word / VAD côté Web Audio API
- Le drag-drop documents
- Le bot Telegram, le pipeline digest, les MCP servers

Pour aller plus loin il faudra un fixture cookie session valide. Pas
fait par défaut pour ne pas embarquer de secret dans le repo.

## CI

Pas branché en CI pour l'instant — le runner GitHub n'a pas le cookie
session prod et lancer le cockpit local en CI demande de stub la DB.
Test à lancer à la main après chaque chantier qui touche au login, à
l'auth gate ou aux routes publiques.
