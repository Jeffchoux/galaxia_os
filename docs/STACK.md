# Stack Galaxia — décortiquée

## La pile, du bas vers le haut

```
┌─────────────────────────────────────────────────────┐
│  Galaxia (PME-friendly UX, Hub&Spoke, branding)     │
├─────────────────────────────────────────────────────┤
│  NemoClaw (NVIDIA, Apache 2.0, early preview 2026)  │
│  → OpenShell runtime, sandbox, routed inference,    │
│    hardening, state mgmt, channel messaging         │
├─────────────────────────────────────────────────────┤
│  OpenClaw (Peter Steinberger, MIT, Node 24)         │
│  → CLI, daemon, gateway WebSocket, 20+ channels     │
├─────────────────────────────────────────────────────┤
│  Ollama (LLM local, llama3.1:8b déjà présent)       │
├─────────────────────────────────────────────────────┤
│  Caddy (TLS auto) + Docker (packaging)              │
└─────────────────────────────────────────────────────┘
```

## OpenClaw — couche moteur agentic

- **Runtime** : Node 24 (ou 22.19+ minimum)
- **Install** : `npm install -g openclaw@latest && openclaw onboard --install-daemon`
- **Modes d'exécution** : CLI, daemon (systemd/launchd), WebSocket gateway
- **LLM par défaut** : OpenAI via OAuth subscription. Pas de support Ollama natif documenté.
- **Channels intégrés** : WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, Matrix, etc.
- **Config** : `~/.openclaw/openclaw.json` (workspace : `~/.openclaw/workspace`)
- **Fichiers d'injection prompt** : `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `skills/<x>/SKILL.md`

## NemoClaw — couche sécurité NVIDIA

- **Licence** : Apache 2.0
- **Requirements** (officiels) :
  - Min : 4 vCPU, 8 GB RAM, 20 GB disque
  - **Recommandé : 4+ vCPU, 16 GB RAM, 40 GB disque** ← OpenJeff coche pile
- **GPU** : **non requis** (Galaxia peut donc tourner sur du CPU pur — confirmation cruciale)
- **Install** : `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`
- **Apport** : OpenShell runtime + sandbox image (~2.4 GB compressé) + onboarding guidé + blueprint hardened + state mgmt + channel messaging géré par OpenShell + routed inference (probablement le point d'attache pour Ollama) + protection en couches

## Galaxia — couche distribution PME

Ce que Galaxia ajoute par-dessus NemoClaw :

1. **Hub & Spoke** : mécanisme de mise à jour quotidien des galaxies filles depuis la mère (voir [`UPDATES.md`](UPDATES.md))
2. **Packaging Docker** : tout dans des containers pour déploiement reproductible (NemoClaw expose un sandbox, on l'enveloppe en image Galaxia)
3. **Caddy + sous-domaines** : `app.galaxia-os.com` (UI), `updates.` (registry), `install.` (script), `docs.`
4. **Branding et UX manager-friendly** : pas d'exposition du CLI OpenClaw aux utilisateurs PME finaux ; interface "Hey Galaxia"
5. **Routage Ollama** : configurer NemoClaw pour utiliser Ollama local par défaut (souveraineté), avec clé OpenAI/Anthropic en option

## Questions ouvertes

- [ ] **Clés API** : la galaxie mère et chaque galaxie fille ont besoin d'une clé OpenAI (ou équivalent) pour OpenClaw. Stratégie : config par PME ? Mode "Ollama only" possible ?
- [ ] **Routed inference NemoClaw → Ollama** : à valider que NemoClaw permet de pointer son inférence vers un endpoint Ollama local plutôt qu'OpenAI
- [ ] **Channels** : quels canaux activer par défaut sur les galaxies PME ? (WhatsApp et Slack semblent les plus pertinents en B2B)
- [ ] **Wake word "Hey Galaxia"** : OpenClaw ne mentionne pas de wake word audio dans la doc ; à clarifier si c'est une couche à ajouter ou si NemoClaw l'apporte
